import './src/env.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWatchedFilms, LetterboxdError, normalizeUsername } from './src/letterboxd.js';
import { isConfigured } from './src/tmdb.js';
import { createGame, checkGuess, revealAnswer, getRound } from './src/game.js';
import { stillsDir, hasVideoTools } from './src/videos.js';
import { rootDir } from './src/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '32kb' }));

// Status + config check for the frontend banner.
app.get('/api/health', async (req, res) => {
  res.json({
    ok: true,
    tmdbConfigured: isConfigured(),
    mock: process.env.MOCK === '1',
    videoTools: await hasVideoTools(),
  });
});

// Lookup a user's watch history (uses the server-side cache) so the UI can
// show "Found N films" before the stills are resolved.
app.get('/api/letterboxd/:username', async (req, res, next) => {
  try {
    const username = normalizeUsername(req.params.username);
    const films = await getWatchedFilms(username);
    res.json({
      username,
      filmCount: films.length,
      sample: films.slice(0, 3).map((f) => f.title),
    });
  } catch (err) {
    next(err);
  }
});

// Create a game. Responds with still URLs per round; titles stay server-side.
// Insane (footage) rounds come back empty and are fetched per-round as the
// background extraction pipeline finishes them.
app.post('/api/games', async (req, res, next) => {
  try {
    const { username, rounds, difficulty } = req.body || {};
    const game = await createGame(username, Number(rounds) || 10, difficulty || 'normal');
    res.json(game);
  } catch (err) {
    next(err);
  }
});

// Round readiness for footage rounds (normal rounds are always ready).
app.get('/api/games/:id/rounds/:index', (req, res, next) => {
  try {
    res.json(getRound(req.params.id, req.params.index));
  } catch (err) {
    next(err);
  }
});

// Extracted trailer frames, cached on disk.
app.get('/api/stills/:id/:name', (req, res) => {
  const { id, name } = req.params;
  if (!/^\d+$/.test(id) || !/^still-\d+\.jpg$/.test(name)) {
    return res.status(400).json({ error: 'Bad still path.' });
  }
  res.sendFile(path.join(stillsDir, id, name), (err) => {
    if (err) res.status(404).json({ error: 'Still not found.' });
  });
});

app.post('/api/games/:id/guess', (req, res, next) => {
  try {
    res.json(checkGuess(req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});

app.post('/api/games/:id/reveal', (req, res, next) => {
  try {
    res.json(revealAnswer(req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof LetterboxdError) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`movie-guessr running at http://localhost:${PORT}`);
  if (!isConfigured()) {
    console.log(
      '\n  TMDB API key not set \u2014 add TMDB_API_KEY to .env and restart.\n' +
        '  (Get a free key at https://www.themoviedb.org/settings/api)\n',
    );
  }
});
