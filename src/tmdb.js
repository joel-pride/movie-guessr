// TMDB access: resolves a film (title + year, or a known TMDB id) to up to
// five still images (backdrops) and a poster. Supports both the v3 API key
// and the v4 read-access token.

import { mockResolveFilm } from './mock.js';

const API_BASE = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';
const MOCK = process.env.MOCK === '1';

const apiKey = process.env.TMDB_API_KEY || process.env.TMDB_ACCESS_TOKEN || '';
const isV4Token = apiKey.startsWith('ey'); // v4 read tokens are JWTs

const STILL_COUNT = 5; // stills shown per round
const SAMPLE_WINDOW = 15; // consider this many of the least-voted backdrops
const MIN_WIDTH = 1280; // skip tiny low-quality uploads

const shuffle = (arr) => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// Chooses up to five backdrops that make a hard round: community-uploaded
// screenshots of actual frames rather than official publicity stills.
//  - Backdrops are sorted least-voted first: the most-voted are the instantly
//    recognisable primary shots, while zero-vote uploads are usually real
//    screenshots people grabbed from the film.
//  - Backdrops carrying a language tag usually have burned-in promo text;
//    they're only used to top up a thin pool.
//  - Promotional wallpapers are generic 16:9 regardless of the film's real
//    aspect ratio, so only the film's dominant ratio is kept when possible.
//  - The least-voted tail includes tiny/stretched uploads, so a minimum
//    width floor applies when enough larger images exist.
function pickStills(backdrops) {
  const byVotesAsc = (a, b) => (a.vote_count || 0) - (b.vote_count || 0);
  const all = backdrops.slice().sort(byVotesAsc);

  let pool = all.filter((b) => !b.iso_639_1);
  if (pool.length < STILL_COUNT) pool = all;

  const hd = pool.filter((b) => (b.width || 0) >= MIN_WIDTH);
  if (hd.length >= STILL_COUNT) pool = hd;

  const ratioCounts = new Map();
  for (const b of pool) {
    if (typeof b.aspect_ratio === 'number') {
      const key = b.aspect_ratio.toFixed(2);
      ratioCounts.set(key, (ratioCounts.get(key) || 0) + 1);
    }
  }
  const dominantRatio = [...ratioCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (dominantRatio && pool.length >= STILL_COUNT) {
    const matching = pool.filter((b) => b.aspect_ratio?.toFixed(2) === dominantRatio);
    if (matching.length >= STILL_COUNT) pool = matching;
  }

  const picked = shuffle(pool.slice(0, SAMPLE_WINDOW)).slice(0, STILL_COUNT);
  picked.sort(byVotesAsc); // least iconic first
  return picked;
}

export function isConfigured() {
  return MOCK || !!apiKey;
}

const cache = new Map();

async function tmdb(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const cacheKey = url.toString();
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const headers = {};
  if (isV4Token) headers.Authorization = `Bearer ${apiKey}`;
  else url.searchParams.set('api_key', apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } catch {
    throw new Error('Could not reach TMDB. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    throw new Error('TMDB rejected the API key. Check TMDB_API_KEY in your .env file.');
  }
  if (!res.ok) {
    throw new Error(`TMDB request failed (${res.status}).`);
  }
  const json = await res.json();
  cache.set(cacheKey, json);
  return json;
}

async function searchMovieId(title, year) {
  const base = { query: title, include_adult: 'false' };
  let results = (await tmdb('/search/movie', year ? { ...base, year } : base)).results || [];
  if (results.length === 0 && year) {
    results = (await tmdb('/search/movie', base)).results || [];
  }
  return results[0]?.id ?? null;
}

export { searchMovieId as resolveTmdbId };

// Picks the best YouTube video to pull real footage from: Clips are actual
// scene excerpts, trailers next, teasers last.
export async function getTrailerKey(id) {
  try {
    const data = await tmdb(`/movie/${id}/videos`, { language: 'en-US' });
    const videos = (data.results || []).filter((v) => v.site === 'YouTube' && v.key);
    for (const type of ['Clip', 'Trailer', 'Teaser', 'Featurette']) {
      const v = videos.find((v) => v.type === type);
      if (v) return v.key;
    }
    return null;
  } catch {
    return null;
  }
}

// Title/year/poster for the result screen, used by footage rounds that skip
// the full backdrop resolution.
export async function getMovieMeta(id) {
  const [details, images] = await Promise.all([
    tmdb(`/movie/${id}`),
    tmdb(`/movie/${id}/images`, { include_image_language: 'en,null' }),
  ]);
  const posterPath = (images.posters || [])[0]?.file_path;
  return {
    title: details.title,
    year: details.release_date ? Number(details.release_date.slice(0, 4)) : null,
    posterUrl: posterPath ? `${IMG_BASE}/w342${posterPath}` : null,
  };
}

// Returns { id, title, year, stills: [url...], posterUrl } or null when the
// film can't be found / has no usable backdrops.
export async function resolveFilm(film) {
  if (MOCK) return mockResolveFilm(film);

  const id = film.tmdbId || (await searchMovieId(film.title, film.year));
  if (!id) return null;

  const images = await tmdb(`/movie/${id}/images`, { include_image_language: 'en,null' });
  if ((images.backdrops || []).length === 0) return null;

  const picked = pickStills(images.backdrops);

  const details = await tmdb(`/movie/${id}`);
  const posterPath = (images.posters || [])[0]?.file_path;

  return {
    id,
    slug: film.slug || null,
    title: details.title || film.title,
    year: details.release_date ? Number(details.release_date.slice(0, 4)) : film.year,
    stills: picked.map((b) => `${IMG_BASE}/w1280${b.file_path}`),
    posterUrl: posterPath ? `${IMG_BASE}/w342${posterPath}` : null,
  };
}
