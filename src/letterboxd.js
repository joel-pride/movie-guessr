// Fetches a Letterboxd user's watched films.
//
// Two sources, combined and deduped by film slug:
//  1. RSS feed (https://letterboxd.com/{user}/rss/) — reliable, includes the
//     TMDB movie id for each diary entry, but limited to ~100 recent entries.
//  2. Grid scrape of /films/ pages — the full watch history (title + year),
//     best effort: Cloudflare challenges rapid sequential requests, so we stop
//     at the first blocked page and keep whatever we have.

import { MOCK_FILMS } from './mock.js';

const LB = 'https://letterboxd.com';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CACHE_TTL = 5 * 60 * 1000;
const MOCK = process.env.MOCK === '1';
const MAX_SCRAPE_PAGES = 6;
const SCRAPE_DELAY_MS = 600;
const FULL_PAGE_ITEMS = 70; // grid pages hold 72 posters; <70 means last page

export class LetterboxdError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const cache = new Map(); // username -> { films, at }

export function normalizeUsername(raw) {
  let u = String(raw || '').trim().toLowerCase();
  u = u.replace(/^@/, '');
  const urlMatch = u.match(/letterboxd\.com\/(?:u\/)?([a-z0-9_.-]+)/);
  if (urlMatch) u = urlMatch[1];
  u = u.replace(/\/+$/, '');
  if (!/^[a-z0-9_.-]{1,32}$/.test(u)) {
    throw new LetterboxdError('That doesn\u2019t look like a valid Letterboxd username.');
  }
  return u;
}

async function fetchText(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch {
    return { status: 0, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (m, name) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ',
    }[name] ?? m));
}

function extractTag(block, tag) {
  const m = block.match(
    new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`),
  );
  return m ? decodeEntities(m[1].trim()) : null;
}

// RSS items look like:
// <letterboxd:filmTitle>Mad Max: Fury Road</letterboxd:filmTitle>
// <letterboxd:filmYear>2015</letterboxd:filmYear>
// <tmdb:movieId>76341</tmdb:movieId>
// <link>https://letterboxd.com/{user}/film/{slug}/</link>
function parseRss(xml) {
  const films = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const item of items) {
    const title = extractTag(item, 'letterboxd:filmTitle');
    if (!title) continue;
    const yearStr = extractTag(item, 'letterboxd:filmYear');
    const tmdbStr = extractTag(item, 'tmdb:movieId');
    const link = extractTag(item, 'link') || '';
    const slugMatch = link.match(/\/film\/([^/]+)/);
    films.push({
      title,
      year: /^\d{4}$/.test(yearStr || '') ? Number(yearStr) : null,
      slug: slugMatch ? slugMatch[1] : null,
      tmdbId: tmdbStr ? Number(tmdbStr) : null,
    });
  }
  return films;
}

// Grid pages render each film as a react-component div carrying
// data-component-class="LazyPoster" data-item-name="Title (Year)"
// data-item-slug="title-year". We match whole div tags and pull the
// attributes individually so their order doesn't matter.
function parseGrid(html) {
  const films = [];
  const tagRe = /<div\b[^>]*data-item-slug="[^"]*"[^>]*>/g;
  for (const m of html.matchAll(tagRe)) {
    const tag = m[0];
    if (!tag.includes('LazyPoster')) continue;
    const slug = tag.match(/data-item-slug="([^"]*)"/)?.[1];
    const name = decodeEntities(tag.match(/data-item-name="([^"]*)"/)?.[1] || '');
    if (!slug || !name) continue;
    const yearMatch = name.match(/\s\((\d{4})\)$/);
    films.push({
      title: yearMatch ? name.slice(0, yearMatch.index) : name,
      year: yearMatch ? Number(yearMatch[1]) : null,
      slug,
      tmdbId: null,
    });
  }
  return films;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isBlocked(status, text) {
  return status !== 200 || text.includes('Just a moment') || text.includes('challenges.cloudflare');
}

export async function getWatchedFilms(usernameInput) {
  if (MOCK) {
    await sleep(200); // simulate network
    return MOCK_FILMS;
  }

  const username = normalizeUsername(usernameInput);

  const cached = cache.get(username);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.films;

  const bySlug = new Map();
  const add = (film) => {
    const key = film.slug || `${film.title}|${film.year}`;
    const existing = bySlug.get(key);
    if (!existing || (!existing.tmdbId && film.tmdbId)) bySlug.set(key, film);
  };

  // RSS first: reliable, and carries TMDB ids.
  const rss = await fetchText(`${LB}/${username}/rss/`);
  let rssOk = rss.status === 200;
  if (rssOk) parseRss(rss.text).forEach(add);

  // Grid scrape: the full watch history, best effort.
  let gridReached = false;
  for (let page = 1; page <= MAX_SCRAPE_PAGES; page++) {
    const url = `${LB}/${username}/films/${page > 1 ? `page/${page}/` : ''}`;
    const res = await fetchText(url);
    if (res.status === 404) {
      if (page === 1 && !rssOk) {
        throw new LetterboxdError(`Letterboxd user \u201C${username}\u201D wasn\u2019t found. Check the spelling?`, 404);
      }
      break;
    }
    if (isBlocked(res.status, res.text)) break; // Cloudflare — keep what we have
    const pageFilms = parseGrid(res.text);
    gridReached = gridReached || pageFilms.length > 0;
    if (pageFilms.length === 0) break;
    pageFilms.forEach(add);
    if (pageFilms.length < FULL_PAGE_ITEMS) break; // last page
    await sleep(SCRAPE_DELAY_MS);
  }

  const films = [...bySlug.values()];

  if (films.length === 0) {
    if (!rssOk && !gridReached) {
      throw new LetterboxdError(
        'Letterboxd is rate-limiting requests (Cloudflare). Wait a minute and try again.',
        503,
      );
    }
    throw new LetterboxdError(
      `Couldn\u2019t find any watched films for \u201C${username}\u201D. ` +
        'Their profile may be private, or they haven\u2019t logged any films.',
      404,
    );
  }

  cache.set(username, { films, at: Date.now() });
  return films;
}
