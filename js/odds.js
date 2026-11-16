// Crossword Slots — live win odds. Runs on the host's phone, which knows every hand,
// so these are true odds (like the percentages on TV poker), not guesses.

import { toInts, bestScoreI, combos } from './engine.js';

// hands:  [{ id, cards }] every hand in play, the Pocket included
// mode:   'any' | 'exact'
// boards: for each board, the cards already face up (0 to 5 of them)
// unseen: cards that could still be dealt
// Returns, for each board, { id: share } where share is the fraction of that board's pot
// the hand expects to win (ties count as a split). Shares on a board add up to 1.
export function computeOdds(hands, mode, boards, unseen, rnd = Math.random, budget = 150000) {
  const H = hands.map((h) => ({ id: h.id, cards: toInts(h.cards) }));
  const U = toInts(unseen);
  const n = H[0].cards.length;
  const perHand = mode === 'exact' ? (n * (n - 1) / 2) * 10 : 1 + n * 5 + (n * (n - 1) / 2) * 10;
  const perOutcome = perHand * H.length;
  const cache = new Map();
  const scores = new Array(H.length);

  const run = (known) => {
    const need = 5 - known.length;
    const tally = new Float64Array(H.length);
    const board = known.concat(new Array(need).fill(0));
    let outcomes = 0;
    const score = () => {
      let top = 0;
      let count = 0;
      for (let i = 0; i < H.length; i++) {
        const s = bestScoreI(H[i].cards, board, mode);
        scores[i] = s;
        if (s > top) { top = s; count = 1; } else if (s === top) count++;
      }
      for (let i = 0; i < H.length; i++) if (scores[i] === top) tally[i] += 1 / count;
      outcomes++;
    };
    const maxSamples = Math.max(200, Math.min(2000, Math.floor(budget / perOutcome)));
    let total = 1;
    for (let i = 0; i < need; i++) total = (total * (U.length - i)) / (i + 1);
    if (need === 0) {
      score();
    } else if (total <= maxSamples * 2) {
      // few enough possibilities: check every one, so the answer is exact
      for (const pick of combos(U, need)) {
        for (let i = 0; i < need; i++) board[known.length + i] = pick[i];
        score();
      }
    } else {
      const pool = U.slice();
      for (let k = 0; k < maxSamples; k++) {
        for (let i = 0; i < need; i++) {
          const j = i + Math.floor(rnd() * (pool.length - i));
          const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
          board[known.length + i] = pool[i];
        }
        score();
      }
    }
    const out = {};
    H.forEach((h, i) => { out[h.id] = tally[i] / outcomes; });
    return out;
  };

  return boards.map((known) => {
    const key = known.join('');
    if (!cache.has(key)) cache.set(key, run(toInts(known)));
    return cache.get(key);
  });
}
