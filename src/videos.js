// Extracts still frames from a film's trailer/clip footage. TMDB's videos
// endpoint provides the YouTube key; yt-dlp downloads the video (720p cap),
// ffmpeg grabs frames at five spread-out timestamps, and the source video is
// deleted immediately after. Only the frames are cached on disk (~1MB/film)
// under .stills-cache/{tmdbId}/, served from /api/stills.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rootDir } from './env.js';

const FRAME_COUNT = 5;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const CACHE_DIR = path.join(rootDir, '.stills-cache');

const inflight = new Map(); // tmdbId -> extraction promise

export function run(cmd, args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.slice(-400)}`));
    });
  });
}

let toolsPromise = null;
export function hasVideoTools() {
  toolsPromise ??= (async () => {
    try {
      await run('yt-dlp', ['--version'], 10_000);
      await run('ffmpeg', ['-version'], 10_000);
      await run('ffprobe', ['-version'], 10_000);
      return true;
    } catch {
      return false;
    }
  })();
  return toolsPromise;
}

export function cachedStills(tmdbId) {
  const dir = path.join(CACHE_DIR, String(tmdbId));
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^still-\d+\.jpg$/.test(f)).sort();
  if (files.length === 0) return null;
  return files.map((f) => `/api/stills/${tmdbId}/${f}`);
}

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function doExtract(tmdbId, youtubeKey) {
  const cached = cachedStills(tmdbId);
  if (cached) return cached;

  const outDir = path.join(CACHE_DIR, String(tmdbId));
  mkdirSync(outDir, { recursive: true });

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'movie-guessr-'));
  try {
    await run('yt-dlp', [
      '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
      '--no-playlist',
      '-o', path.join(tmp, 'video.%(ext)s'),
      `https://www.youtube.com/watch?v=${youtubeKey}`,
    ], DOWNLOAD_TIMEOUT_MS);

    const video = (readdirSync(tmp).find((f) => f.startsWith('video.')));
    if (!video) throw new Error('yt-dlp produced no video file');
    const videoPath = path.join(tmp, video);

    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', videoPath,
    ]);
    const duration = Number(stdout.trim().split('\n').pop());
    if (!Number.isFinite(duration) || duration < 10) {
      throw new Error(`unusable video duration: ${duration}`);
    }

    // Five timestamps spread between 8% and 92% of the runtime (skipping
    // studio logos up front and the tail), one jittered pick per fifth so
    // frames don't cluster together.
    const stamps = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const lo = duration * (0.08 + (0.84 * i) / FRAME_COUNT);
      const hi = duration * (0.08 + (0.84 * (i + 1)) / FRAME_COUNT);
      stamps.push(lo + Math.random() * (hi - lo));
    }

    for (const [i, t] of shuffle(stamps).entries()) {
      await run('ffmpeg', [
        '-y', '-v', 'error',
        '-ss', t.toFixed(2), '-i', videoPath,
        '-frames:v', '1', '-q:v', '3',
        path.join(outDir, `still-${i + 1}.jpg`),
      ], 60_000);
    }

    const result = cachedStills(tmdbId);
    if (!result) throw new Error('frame extraction produced no files');
    return result;
  } finally {
    await rm(tmp, { recursive: true, force: true }); // never keep the video
  }
}

export function extractStills(tmdbId, youtubeKey) {
  if (inflight.has(tmdbId)) return inflight.get(tmdbId);
  const job = doExtract(tmdbId, youtubeKey).finally(() => inflight.delete(tmdbId));
  inflight.set(tmdbId, job);
  return job;
}

export const stillsDir = CACHE_DIR;
