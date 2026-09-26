// Fuzzy title matching for guesses. Runs server-side so answers never
// need to reach the browser before they are guessed or revealed.

export function normalizeTitle(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')      // strip diacritics
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

// True if the guess is "close enough" to the answer:
//  - exact after normalization (case, punctuation, diacritics, leading article)
//  - one title is a whole-word substring of the other ("harry potter" vs
//    "harry potter and the prisoner of azkaban"), min length 5
//  - small edit distance (typos, missing colon, "spiderman" vs "spider man")
//  - a year appended to the guess ("dune 1984") is ignored, but never in a
//    way that could empty a numeric title like "1917"
export function isTitleMatch(guess, answer) {
  const g = normalizeTitle(guess);
  const a = normalizeTitle(answer);
  if (!g || !a) return false;
  if (matchNormalized(g, a)) return true;

  const gNoYear = g.replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
  return gNoYear !== g && gNoYear.length > 0 && matchNormalized(gNoYear, a);
}

function matchNormalized(g, a) {
  if (g === a) return true;

  const minLen = Math.min(g.length, a.length);
  if (minLen >= 5) {
    const wordBoundary = (needle, hay) =>
      new RegExp(`(^| )${escapeRegex(needle)}( |$)`).test(hay);
    if (wordBoundary(g, a) || wordBoundary(a, g)) return true;
  }

  if (minLen <= 4) return false; // short titles must match exactly
  const d = levenshtein(g, a);
  if (Math.max(g.length, a.length) >= 14) return d <= 3;
  return d <= 2;
}
