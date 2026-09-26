// movie-guessr client. Screens: setup -> loading -> game <-> result -> summary.

const $ = (id) => document.getElementById(id);

const screens = ['screen-setup', 'screen-loading', 'screen-game', 'screen-result', 'screen-summary'];

const state = {
  username: '',
  roundsWanted: 10,
  difficulty: 'normal',
  gameId: null,
  rounds: [],        // [{ images: [url, ...] }] (footage rounds fill in lazily)
  roundIdx: 0,
  revealed: 1,
  viewIdx: 1,        // which revealed still is on the stage right now
  locked: false,     // blocks guessing while a round end is pending
  roundDone: false,
  endTimer: null,
  score: 0,
  results: [],       // [{ title, year, points, won, stillCount }]
  triedGuesses: new Set(),
};

const WRONG_MESSAGES = [
  'Not quite — next still!',
  'Nope. Moving on…',
  'Not it — another angle.',
  'Nope, not that one.',
];
const LAST_WRONG_MESSAGE = 'Nope — and that was your last still…';

// Difficulty mechanic: the first reveal is an extreme close-up of a random
// region of the still; each later still pulls back geometrically until the
// final reveal shows the full frame.
const MAX_ZOOM = 2.6;

function zoomFor(revealed, total) {
  if (total <= 1) return 1;
  const t = (revealed - 1) / (total - 1);
  return MAX_ZOOM * Math.pow(1 / MAX_ZOOM, t);
}

/* ---------- helpers ---------- */

function showScreen(id) {
  for (const s of screens) $(s).hidden = s !== id;
}

function setTopbar() {
  $('topbarStats').hidden = false;
  $('statRound').textContent = `Round ${state.roundIdx + 1}/${state.rounds.length}`;
  $('statScore').textContent = `${state.score} pts`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------- setup & loading ---------- */

async function checkHealth() {
  try {
    const health = await api('/api/health');
    $('tmdbBanner').hidden = health.tmdbConfigured;
  } catch { /* server unreachable; the game call will surface errors */ }
}

async function startGame(username, roundsWanted, difficulty = 'normal') {
  state.username = username;
  state.roundsWanted = roundsWanted;
  state.difficulty = difficulty;
  $('loadingText').textContent = 'Fetching your Letterboxd films…';
  $('loadingSub').textContent = '';
  showScreen('screen-loading');

  try {
    const lookup = await api(`/api/letterboxd/${encodeURIComponent(username)}`);
    $('loadingText').textContent =
      difficulty === 'insane' ? 'Setting up footage rounds…' : 'Picking films and loading stills…';
    $('loadingSub').textContent =
      `Found ${lookup.filmCount} watched films for @${lookup.username}`;

    const game = await api('/api/games', {
      method: 'POST',
      body: { username, rounds: roundsWanted, difficulty },
    });

    state.gameId = game.gameId;
    state.rounds = game.rounds;
    state.roundIdx = 0;
    state.score = 0;
    state.results = [];
    beginRound();
  } catch (err) {
    showScreen('screen-setup');
    const el = $('setupError');
    el.textContent = err.message;
    el.hidden = false;
  }
}

/* ---------- game ---------- */

function beginRound() {
  state.revealed = 1;
  state.viewIdx = 1;
  state.locked = false;
  state.roundDone = false;
  if (state.endTimer) clearTimeout(state.endTimer);
  state.endTimer = null;
  state.triedGuesses = new Set();
  // One focal point per round: the camera feels like it's pulling back from
  // the same spot as stills are revealed.
  state.focal = {
    x: 15 + Math.random() * 70,
    y: 15 + Math.random() * 70,
  };
  $('guessInput').value = '';
  $('guessFeedback').textContent = '';
  $('guessFeedback').className = 'guess-feedback';
  setTopbar();
  showScreen('screen-game');
  loadRound();
}

// Footage (insane) rounds arrive empty and are polled until the server's
// extraction pipeline has them ready.
async function loadRound() {
  const round = state.rounds[state.roundIdx];

  if (!round.images.length) {
    showPreparing(true);
    try {
      const ready = await pollRound(state.roundIdx);
      if (ready.failed || !ready.images.length) {
        showPreparing(false);
        skipFailedRound();
        return;
      }
      round.images = ready.images;
    } catch (err) {
      showPreparing(false);
      const fb = $('guessFeedback');
      fb.textContent = err.message;
      fb.className = 'guess-feedback wrong';
      return;
    }
    showPreparing(false);
  }

  renderRound();
  $('guessInput').focus();

  // Warm the cache so later stills appear instantly.
  for (const src of round.images) {
    const img = new Image();
    img.src = src;
  }
}

async function pollRound(idx) {
  const started = Date.now();
  for (;;) {
    const r = await api(`/api/games/${state.gameId}/rounds/${idx}`);
    if (r.ready) return r;
    if (Date.now() - started > 4 * 60 * 1000) {
      throw new Error('Preparing this round is taking unusually long. Start a new game.');
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
}

function showPreparing(on) {
  $('preparingOverlay').hidden = !on;
  $('guessInput').disabled = on;
  $('guessBtn').disabled = on;
  $('nextStillBtn').disabled = on;
  $('giveUpBtn').disabled = on;
  if (on) $('stageSpinner').style.display = 'none';
}

function skipFailedRound() {
  state.results.push({ title: '(skipped)', year: null, points: 0, won: false });
  const fb = $('guessFeedback');
  fb.textContent = 'This round could not be prepared — skipping it.';
  fb.className = 'guess-feedback hint';
  setTimeout(advanceAfterRound, 1400);
}

function renderRound() {
  const total = state.rounds[state.roundIdx].images.length;
  state.viewIdx = state.revealed;

  const points = total + 1 - state.revealed;
  $('worthBadge').innerHTML = `This film is worth <b>${points} pt${points === 1 ? '' : 's'}</b>`;

  const nextBtn = $('nextStillBtn');
  nextBtn.disabled = false;
  nextBtn.textContent = 'Skip this still';
  nextBtn.hidden = state.revealed >= total;

  showStill(state.viewIdx);
}

// Puts still n (1-based) on the stage, cropped exactly as it was revealed.
function showStill(n) {
  state.viewIdx = n;
  const round = state.rounds[state.roundIdx];
  const total = round.images.length;

  const zoomWrap = $('stillZoom');
  zoomWrap.style.transformOrigin = `${state.focal.x}% ${state.focal.y}%`;
  zoomWrap.style.transform = `scale(${zoomFor(n, total)})`;

  const img = $('stillImage');
  img.classList.remove('loaded');
  $('stageSpinner').style.display = 'block';
  img.onload = () => {
    img.classList.add('loaded');
    $('stageSpinner').style.display = 'none';
  };
  img.src = round.images[n - 1];

  renderStrip();
}

function renderStrip() {
  const round = state.rounds[state.roundIdx];
  const total = round.images.length;
  const strip = $('stillsStrip');
  strip.innerHTML = '';

  for (let i = 1; i <= total; i++) {
    if (i > state.revealed) {
      const empty = document.createElement('span');
      empty.className = 'still-thumb empty';
      strip.appendChild(empty);
      continue;
    }
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'still-thumb'
      + (i === state.viewIdx ? ' active' : '')
      + (i === state.revealed ? ' latest' : '');
    thumb.setAttribute('aria-label', `View still ${i} of ${total}`);

    // Mirror the stage: same crop the still was revealed at.
    const zoom = document.createElement('span');
    zoom.className = 'thumb-zoom';
    zoom.style.transformOrigin = `${state.focal.x}% ${state.focal.y}%`;
    zoom.style.transform = `scale(${zoomFor(i, total)})`;
    const img = document.createElement('img');
    img.src = round.images[i - 1];
    img.alt = '';
    zoom.appendChild(img);
    thumb.appendChild(zoom);

    thumb.addEventListener('click', () => showStill(i));
    strip.appendChild(thumb);
  }
}

function advanceStill() {
  const total = state.rounds[state.roundIdx].images.length;
  if (state.revealed >= total) return;
  state.revealed++;
  renderRound();
  if (state.revealed === total) {
    const fb = $('guessFeedback');
    fb.textContent = 'Last still — final guess!';
    fb.className = 'guess-feedback hint';
  }
  $('guessInput').focus();
}

async function submitGuess() {
  if ($('guessInput').disabled || state.locked || state.roundDone) return;
  const raw = $('guessInput').value.trim();
  if (!raw) return;
  const fb = $('guessFeedback');
  fb.className = 'guess-feedback';

  const normalizedGuess = raw.toLowerCase();
  if (state.triedGuesses.has(normalizedGuess)) {
    fb.textContent = 'You already tried that one.';
    fb.className = 'guess-feedback hint';
    return;
  }
  state.triedGuesses.add(normalizedGuess);

  try {
    const res = await api(`/api/games/${state.gameId}/guess`, {
      method: 'POST',
      body: { round: state.roundIdx, guess: raw },
    });
    if (res.correct) {
      finishRound(true, res.answer);
    } else {
      const row = $('guessForm');
      row.classList.remove('shake');
      void row.offsetWidth; // restart the animation
      row.classList.add('shake');
      fb.className = 'guess-feedback wrong';

      const total = state.rounds[state.roundIdx].images.length;
      if (state.revealed < total) {
        // One guess per still: a wrong answer burns the still and moves on.
        fb.textContent = WRONG_MESSAGES[Math.floor(Math.random() * WRONG_MESSAGES.length)];
        advanceStill();
      } else {
        fb.textContent = LAST_WRONG_MESSAGE;
        state.locked = true;
        state.endTimer = setTimeout(() => giveUp(), 1400);
      }
    }
  } catch (err) {
    fb.textContent = err.message;
    fb.className = 'guess-feedback wrong';
  }
  $('guessInput').focus();
}

async function giveUp() {
  if (state.roundDone) return;
  try {
    const res = await api(`/api/games/${state.gameId}/reveal`, {
      method: 'POST',
      body: { round: state.roundIdx },
    });
    finishRound(false, res.answer);
  } catch (err) {
    const fb = $('guessFeedback');
    fb.textContent = err.message;
    fb.className = 'guess-feedback wrong';
  }
}

function finishRound(won, answer) {
  if (state.roundDone) return;
  state.roundDone = true;
  state.locked = true;
  if (state.endTimer) {
    clearTimeout(state.endTimer);
    state.endTimer = null;
  }
  const total = state.rounds[state.roundIdx].images.length;
  const points = won ? total + 1 - state.revealed : 0;
  state.score += points;
  state.results.push({ ...answer, points, won, usedStills: state.revealed });

  const verdict = $('verdictText');
  if (won && state.revealed === 1) {
    verdict.textContent = 'First still — nailed it! 🔥';
  } else if (won) {
    verdict.textContent = `Correct! Guessed it on still ${state.revealed} of ${total}`;
  } else {
    verdict.textContent = 'The film was…';
  }
  verdict.className = `verdict ${won ? 'win' : 'lose'}`;

  $('resultTitle').textContent = answer.title;
  $('resultYear').textContent = answer.year ? answer.year : '';
  $('resultPoints').textContent = won ? `+${points} point${points === 1 ? '' : 's'}` : '0 points';

  const poster = $('resultPoster');
  if (answer.posterUrl) {
    poster.src = answer.posterUrl;
    poster.style.display = '';
  } else {
    poster.style.display = 'none';
  }

  const lb = $('letterboxdLink');
  if (answer.letterboxdUrl) {
    lb.href = answer.letterboxdUrl;
    lb.style.display = '';
  } else {
    lb.style.display = 'none';
  }
  $('tmdbLink').href = answer.tmdbUrl;

  const last = state.roundIdx === state.rounds.length - 1;
  $('nextRoundBtn').textContent = last ? 'See results' : 'Next film →';

  setTopbar();
  showScreen('screen-result');
}

/* ---------- summary ---------- */

function showSummary() {
  const max = state.rounds.reduce((sum, r) => sum + r.images.length, 0) === 0
    ? 0
    : state.rounds.reduce((sum, r) => sum + r.images.length, 0);
  const wonCount = state.results.filter((r) => r.won).length;

  $('summaryHeadline').textContent =
    state.score === max ? 'Perfect score! 🏆' :
    state.score >= max * 0.7 ? 'You know your stuff! 🎬' :
    state.score >= max * 0.4 ? 'Not bad — keep watching.' :
    'Time for a rewatch marathon…';

  $('summaryScore').innerHTML =
    `<b>${state.score}</b> / ${max} points · ${wonCount}/${state.results.length} films guessed`;

  const chips = $('summaryChips');
  chips.innerHTML = '';
  for (const r of state.results) {
    const chip = document.createElement('span');
    chip.className = `chip ${r.won ? 'win' : 'lose'}`;
    const label = document.createElement('span');
    label.textContent = `${r.won ? '✓' : '✗'} ${r.title}${r.year ? ` (${r.year})` : ''}`;
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = `${r.points}pt`;
    chip.append(label, pts);
    chips.appendChild(chip);
  }

  showScreen('screen-summary');
}

function advanceAfterRound() {
  if (state.roundIdx === state.rounds.length - 1) {
    showSummary();
  } else {
    state.roundIdx++;
    beginRound();
  }
}

/* ---------- wiring ---------- */

$('setupForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const username = $('usernameInput').value.trim();
  const rounds = Number($('roundsSelect').value);
  const difficulty = $('difficultySelect').value;
  const errEl = $('setupError');
  errEl.hidden = true;
  if (!username) {
    errEl.textContent = 'Enter your Letterboxd username first.';
    errEl.hidden = false;
    return;
  }
  startGame(username, rounds, difficulty);
});

$('guessForm').addEventListener('submit', (e) => {
  e.preventDefault();
  submitGuess();
});

// Explicit Enter handling: implicit form submission is unreliable in some
// embedded webviews.
for (const [inputId, formId] of [['guessInput', 'guessForm'], ['usernameInput', 'setupForm']]) {
  $(inputId).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $(formId).requestSubmit();
    }
  });
}

$('nextStillBtn').addEventListener('click', advanceStill);
$('giveUpBtn').addEventListener('click', giveUp);

$('nextRoundBtn').addEventListener('click', advanceAfterRound);

$('playAgainBtn').addEventListener('click', () => {
  startGame(state.username, state.roundsWanted, state.difficulty);
});

$('newPlayerBtn').addEventListener('click', () => {
  $('topbarStats').hidden = true;
  $('guessInput').value = '';
  showScreen('screen-setup');
  $('usernameInput').focus();
});

checkHealth();
