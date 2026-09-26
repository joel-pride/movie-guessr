# 🎬 movie-guessr

A guessing game built on your own film taste. Enter your Letterboxd username,
pick a mode, and the game picks films you've watched and shows you up to five
stills from each — one at a time, starting zoomed deep into the frame and
pulling back with every reveal. Name the film using as few stills as possible.

Two modes:

- **Normal** — stills from TMDB's least-voted backdrops (community-uploaded
  screenshots rather than official publicity shots).
- **Insane — real footage** — stills are frames yanked from the film's own
  trailer/clips on YouTube (via yt-dlp + ffmpeg): actual footage, arbitrary
  moments, much harder. Rounds prepare in the background while you play; a
  film whose footage can't be fetched quietly falls back to backdrops.

Everything else:

- Rounds start at a 2.6× close-up of a random region and pull back to the
  full frame by the final still
- Language-tagged promo art, off-ratio wallpapers, and tiny low-res uploads
  are filtered out
- Fewer stills needed = more points (5 images → 5 pts down to 1 pt; miss = 0)
- Guesses are matched fuzzily: case, punctuation, accents, leading "the",
  small typos, appended years ("dune 1984"), and partial titles
  ("harry potter" matches "Harry Potter and the Prisoner of Azkaban") all work
- Answers are held server-side — you can't peek at the network tab

## Quick start

```bash
npm install
```

For real-footage (Insane) mode only, install the extraction tools:

```bash
brew install yt-dlp ffmpeg
```

Add your TMDB key to `.env` (copy from `.env.example`):

```
TMDB_API_KEY=your_key_here
```

Run:

```bash
npm start
```

Open http://localhost:3000, enter your Letterboxd username, play.

### How footage rounds work

Frames are extracted once per film and cached in `.stills-cache/` (~1MB per
film); the downloaded video is deleted immediately after extraction. Rounds
resolve sequentially in the background while you play, so typically only the
first round has a visible wait. If YouTube throttles a download or a film has
no usable video, that round falls back to TMDB backdrops.

## How it finds your watched films

Two sources are combined and deduped:

1. **RSS feed** (`letterboxd.com/{user}/rss/`) — reliable and includes the
   TMDB movie id for each entry (exact match, no search needed), but capped
   at the ~100 most recent diary entries.
2. **Films page scrape** (`letterboxd.com/{user}/films/`) — the full watch
   history with titles + years, walked up to 6 pages with a delay between
   requests. This is best-effort: Cloudflare occasionally challenges rapid
   requests, in which case the game quietly falls back to the RSS data.

## Config (`.env` or environment)

| Variable          | Default | Purpose                                      |
| ----------------- | ------- | -------------------------------------------- |
| `TMDB_API_KEY`    | —       | v3 API key **or** v4 read-access token (required to play) |
| `PORT`            | `3000`  | Server port                                  |
| `MOCK`            | off     | `MOCK=1` runs fully offline with fake data (dev) |
| `TMDB_BASE_URL`   | TMDB    | Point TMDB calls at another host (dev)       |

## API

| Route | Purpose |
| ----- | ------- |
| `GET /api/health` | Server status + whether a TMDB key and video tools are set |
| `GET /api/letterboxd/:username` | Watch-history lookup (film count) |
| `POST /api/games` `{username, rounds, difficulty}` | Create a game (`normal` or `insane`); returns still URLs per round (footage rounds come back empty) |
| `GET /api/games/:id/rounds/:index` | Round readiness + still URLs (poll during footage rounds) |
| `GET /api/stills/:movieId/:file` | Cached extracted footage frame |
| `POST /api/games/:id/guess` `{round, guess}` | Check a guess; returns the answer when correct |
| `POST /api/games/:id/reveal` `{round}` | Give up on a round; returns the answer |

## Development

```bash
npm run dev     # auto-restart on changes
MOCK=1 npm start  # offline end-to-end play with fake films/stills
```

Games live in memory (no database) and expire after 3 hours; Letterboxd and
TMDB responses are cached in memory for a few minutes to keep replays fast
and requests polite.
