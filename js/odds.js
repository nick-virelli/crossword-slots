// Crossword Slots — live win odds. Runs on the host's phone, which knows every hand,
// so these are true odds (like the percentages on TV poker), not guesses.

import { toInts, bestScoreI, combos, bestHand, handName, handCategory } from './engine.js?v=1794812783';

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

export const CATEGORY_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

// One player's view of one board: the best hand they hold now and the better kinds of hand
// they could still make, with the exact cards that would do it on the next flip.
// Uses only what that player can see (their own cards and the face-up board).
//   hole: the player's cards   board: 3 to 5 face-up cards   unseen: every card they can't see
// Returns { name, cards, category, toCome, rows: [{ category, label, cards, next, final }] }
//   next  = chance the very next card makes that hand
//   final = chance of ending the board with exactly that hand (only when 2 cards are to come)
export function outlook(hole, board, unseen, mode) {
  const cur = bestHand(hole, board, mode);
  if (!cur) return null;
  const category = handCategory(cur.score);
  const out = { name: handName(cur.score), cards: cur.cards, category, toCome: 5 - board.length, rows: [] };
  if (board.length >= 5 || !unseen.length) return out;
  const helps = new Map();
  for (const c of unseen) {
    const cat = handCategory(bestHand(hole, [...board, c], mode).score);
    if (cat > category) { if (!helps.has(cat)) helps.set(cat, []); helps.get(cat).push(c); }
  }
  const final = new Map();
  if (board.length === 3 && unseen.length >= 2) {
    const H = toInts(hole);
    const B = toInts(board);
    const U = toInts(unseen);
    const full = [B[0], B[1], B[2], 0, 0];
    let total = 0;
    for (let i = 0; i < U.length - 1; i++) {
      for (let j = i + 1; j < U.length; j++) {
        full[3] = U[i]; full[4] = U[j];
        const cat = Math.floor(bestScoreI(H, full, mode) / 759375);
        final.set(cat, (final.get(cat) || 0) + 1);
        total++;
      }
    }
    for (const [k, v] of final) final.set(k, v / total);
  }
  const order = '23456789TJQKA';
  for (let cat = 8; cat > category; cat--) {
    const cards = (helps.get(cat) || []).sort((a, b) => order.indexOf(b[0]) - order.indexOf(a[0]));
    const fin = final.has(cat) ? final.get(cat) : null;
    if (!cards.length && !fin) continue;
    out.rows.push({ category: cat, label: CATEGORY_NAMES[cat], cards, next: cards.length / unseen.length, final: fin });
  }
  return out;
}
