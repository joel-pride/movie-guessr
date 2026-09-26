// Game sessions. The browser only ever receives the still URLs; titles are
// held server-side and returned one round at a time on a correct guess or a
// reveal, so the answers can't be lifted from the network tab.
//
// Two difficulties:
//  - normal: stills are TMDB backdrop images, resolved up front when the
//    game is created (fast).
//  - insane: stills are frames extracted from the film's own trailer/clip
//    footage (yt-dlp + ffmpeg). Each round resolves in a background pipeline
//    while the player works through earlier rounds; the client polls
//    GET /api/games/:id/rounds/:index until a round is ready. Films whose
//    footage can't be fetched fall back to backdrops so a round always plays.

import { randomUUID } from 'node:crypto';
import { getWatchedFilms, LetterboxdError } from './letterboxd.js';
import { resolveFilm, resolveTmdbId, getTrailerKey, getMovieMeta, isConfigured } from './tmdb.js';
import { extractStills, hasVideoTools } from './videos.js';
import { mockResolveFilm } from './mock.js';
import { isTitleMatch } from './match.js';

const MOCK = process.env.MOCK === '1';
const MAX_ROUNDS = 20;
const RESOLVE_BATCH = 5;
const GAME_TTL = 3 * 60 * 60 * 1000;

const games = new Map(); // id -> game

// Sweep expired sessions hourly.
setInterval(() => {
  const now = Date.now();
  for (const [id, g] of games) if (now - g.createdAt > GAME_TTL) games.delete(id);
}, 60 * 60 * 1000).unref();

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function toAnswer(film) {
  return {
    title: film.title,
    year: film.year,
    stillCount: film.stills.length,
    posterUrl: film.posterUrl,
    letterboxdUrl: film.slug ? `https://letterboxd.com/film/${film.slug}/` : null,
    tmdbUrl: `https://www.themoviedb.org/movie/${film.id}`,
  };
}

export async function createGame(username, roundsWanted, difficulty = 'normal') {
  if (difficulty !== 'normal' && difficulty !== 'insane') {
    throw new LetterboxdError('Unknown difficulty. Use "normal" or "insane".', 400);
  }
  if (!isConfigured()) {
    throw new LetterboxdError(
      'No TMDB API key configured. Add TMDB_API_KEY to your .env file and restart the server.',
      503,
    );
  }
  if (difficulty === 'insane' && !MOCK && !(await hasVideoTools())) {
    throw new LetterboxdError(
      'Real-footage mode needs yt-dlp and ffmpeg on the server. Install them with: brew install yt-dlp ffmpeg',
      503,
    );
  }

  const films = await getWatchedFilms(username);
  const pool = shuffle(films);
  const wanted = Math.min(Math.max(1, roundsWanted || 10), MAX_ROUNDS, pool.length);

  if (difficulty === 'insane') {
    const game = {
      difficulty,
      rounds: new Array(wanted).fill(null), // filled by the pipeline below
      films: pool.slice(0, wanted),
      candidates: pool.slice(wanted),
      createdAt: Date.now(),
    };

    // Sequential background pipeline: round 1 becomes playable first, and
    // downloads stay polite. Each round is isolated — a failure never stops
    // the rest of the game.
    (async () => {
      for (let i = 0; i < game.films.length; i++) {
        try {
          game.rounds[i] = await processInsaneRound(game.films[i], game.candidates);
        } catch {
          game.rounds[i] = { failed: true, stills: [] };
        }
      }
    })().catch(() => {});

    const id = randomUUID();
    games.set(id, game);
    return {
      gameId: id,
      poolSize: films.length,
      totalRounds: game.films.length,
      rounds: game.films.map(() => ({ images: [] })), // filled in per-round
    };
  }

  const rounds = [];
  let cursor = 0;
  while (rounds.length < wanted && cursor < pool.length) {
    const chunk = pool.slice(cursor, cursor + RESOLVE_BATCH);
    cursor += chunk.length;
    const settled = await Promise.allSettled(chunk.map(resolveFilm));
    for (const r of settled) {
      if (rounds.length >= wanted) break;
      if (r.status === 'fulfilled' && r.value && r.value.stills.length > 0) {
        rounds.push(r.value);
      }
    }
  }

  if (rounds.length === 0) {
    throw new LetterboxdError(
      'Found your films, but none of them had still images on TMDB. Try again?',
      502,
    );
  }

  const id = randomUUID();
  games.set(id, { difficulty, rounds, createdAt: Date.now() });

  return {
    gameId: id,
    poolSize: films.length,
    totalRounds: rounds.length,
    // Answers withheld: the client gets still URLs only.
    rounds: rounds.map((f) => ({ images: f.stills })),
  };
}

async function processInsaneRound(film, candidates) {
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 1500)); // exercise the preparing UI
    return mockResolveFilm(film);
  }

  try {
    const id = film.tmdbId || (await resolveTmdbId(film.title, film.year));
    if (!id) throw new Error('no TMDB match');
    const key = await getTrailerKey(id);
    if (!key) throw new Error('no YouTube footage');
    const stills = await extractStills(id, key);
    if (stills.length === 0) throw new Error('no frames extracted');

    let meta = {};
    try { meta = await getMovieMeta(id); } catch { /* result card can live without */ }
    return {
      id,
      slug: film.slug || null,
      title: meta.title || film.title,
      year: meta.year ?? film.year,
      posterUrl: meta.posterUrl ?? null,
      stills,
    };
  } catch {
    // No usable footage (throttled download, no video, …): fall back to
    // TMDB backdrops so the round is always playable, substituting another
    // film from the pool if this one has no backdrops either.
    for (const candidate of [film, ...candidates.splice(0, 3)]) {
      const r = await resolveFilm(candidate).catch(() => null);
      if (r && r.stills.length > 0) return r;
    }
    throw new Error('round could not be resolved');
  }
}

function getGame(id) {
  const game = games.get(id);
  if (!game) throw new LetterboxdError('That game has expired. Start a new one.', 404);
  return game;
}

function roundIndexFrom(body, game) {
  const idx = Number(body?.round);
  if (!Number.isInteger(idx) || idx < 0 || idx >= game.rounds.length) {
    throw new LetterboxdError('Invalid round index.', 400);
  }
  return idx;
}

// Polling endpoint for footage (insane) rounds.
export function getRound(gameId, index) {
  const game = getGame(gameId);
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= game.rounds.length) {
    throw new LetterboxdError('Invalid round index.', 400);
  }
  const round = game.rounds[idx];
  if (!round) return { ready: false, images: [] };
  return { ready: true, images: round.stills, failed: !!round.failed };
}

function answerOrThrow(game, idx) {
  const answer = game.rounds[idx];
  if (!answer || answer.failed) {
    throw new LetterboxdError('No answer available for this round.', 409);
  }
  return answer;
}

export function checkGuess(gameId, body) {
  const game = getGame(gameId);
  const idx = roundIndexFrom(body, game);
  const guess = String(body?.guess || '').slice(0, 120);
  const answer = answerOrThrow(game, idx);
  const correct = guess.trim().length > 0 && isTitleMatch(guess, answer.title);
  return { correct, round: idx, ...(correct ? { answer: toAnswer(answer) } : {}) };
}

export function revealAnswer(gameId, body) {
  const game = getGame(gameId);
  const idx = roundIndexFrom(body, game);
  return { round: idx, answer: toAnswer(answerOrThrow(game, idx)) };
}
