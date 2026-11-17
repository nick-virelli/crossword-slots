// Crossword Slots — pure game rules. No DOM, no network. All money is integer cents.

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
export const CARRY_ID = '__carry__';

const RANK_NAMES = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight',
  9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace',
};
const plural = (v) => (v === 6 ? 'Sixes' : RANK_NAMES[v] + 's');

export function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return d;
}

// rnd(n) must return a uniform integer in [0, n)
export function shuffle(deck, rnd) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export function cryptoRnd(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

const rv = (c) => RANKS.indexOf(c[0]) + 2;

// ---------- hand evaluation ----------

const B = 15;
const CAT = B ** 5;

// Cards as small integers for speed: (rank 2-14) * 4 + suit.
const ci = (c) => ((RANKS.indexOf(c[0]) + 2) << 2) | SUITS.indexOf(c[1]);
export const toInts = (cards) => cards.map(ci);

// Score for exactly 5 cards (integer form). Higher is better; equal scores are an exact tie.
export function eval5i(c0, c1, c2, c3, c4) {
  let a = c0 >> 2, b = c1 >> 2, c = c2 >> 2, d = c3 >> 2, e = c4 >> 2, t;
  // sorting network, descending
  if (a < b) { t = a; a = b; b = t; }
  if (d < e) { t = d; d = e; e = t; }
  if (c < e) { t = c; c = e; e = t; }
  if (c < d) { t = c; c = d; d = t; }
  if (b < e) { t = b; b = e; e = t; }
  if (a < d) { t = a; a = d; d = t; }
  if (a < c) { t = a; a = c; c = t; }
  if (b < d) { t = b; b = d; d = t; }
  if (b < c) { t = b; b = c; c = t; }
  let cat, t0, t1, t2, t3, t4;
  if (a === d) { cat = 7; t0 = t1 = t2 = t3 = a; t4 = e; }
  else if (b === e) { cat = 7; t0 = t1 = t2 = t3 = b; t4 = a; }
  else if (a === c && d === e) { cat = 6; t0 = t1 = t2 = a; t3 = t4 = d; }
  else if (a === b && c === e) { cat = 6; t0 = t1 = t2 = c; t3 = t4 = a; }
  else if (a === c) { cat = 3; t0 = t1 = t2 = a; t3 = d; t4 = e; }
  else if (b === d) { cat = 3; t0 = t1 = t2 = b; t3 = a; t4 = e; }
  else if (c === e) { cat = 3; t0 = t1 = t2 = c; t3 = a; t4 = b; }
  else if (a === b && c === d) { cat = 2; t0 = t1 = a; t2 = t3 = c; t4 = e; }
  else if (a === b && d === e) { cat = 2; t0 = t1 = a; t2 = t3 = d; t4 = c; }
  else if (b === c && d === e) { cat = 2; t0 = t1 = b; t2 = t3 = d; t4 = a; }
  else if (a === b) { cat = 1; t0 = t1 = a; t2 = c; t3 = d; t4 = e; }
  else if (b === c) { cat = 1; t0 = t1 = b; t2 = a; t3 = d; t4 = e; }
  else if (c === d) { cat = 1; t0 = t1 = c; t2 = a; t3 = b; t4 = e; }
  else if (d === e) { cat = 1; t0 = t1 = d; t2 = a; t3 = b; t4 = c; }
  else {
    const s = c0 & 3;
    const flush = (c1 & 3) === s && (c2 & 3) === s && (c3 & 3) === s && (c4 & 3) === s;
    const hi = a - e === 4 ? a : (a === 14 && b === 5 ? 5 : 0); // wheel counts as five-high
    if (hi) { cat = flush ? 8 : 4; t0 = hi; t1 = t2 = t3 = t4 = 0; }
    else { cat = flush ? 5 : 0; t0 = a; t1 = b; t2 = c; t3 = d; t4 = e; }
  }
  return ((((cat * B + t0) * B + t1) * B + t2) * B + t3) * B + t4;
}

export function evaluate5(cards) {
  return eval5i(ci(cards[0]), ci(cards[1]), ci(cards[2]), ci(cards[3]), ci(cards[4]));
}

export function handCategory(score) {
  return Math.floor(score / CAT);
}

export function handName(score) {
  const cat = Math.floor(score / CAT);
  let rest = score % CAT;
  const t = [];
  for (let i = 4; i >= 0; i--) {
    t.push(Math.floor(rest / B ** i));
    rest %= B ** i;
  }
  const hi = RANK_NAMES[t[0]];
  switch (cat) {
    case 8: return t[0] === 14 ? 'Royal flush' : `Straight flush, ${hi} high`;
    case 7: return `Four ${plural(t[0])}`;
    case 6: return `Full house, ${plural(t[0])} over ${plural(t[3])}`;
    case 5: return `Flush, ${hi} high`;
    case 4: return `Straight, ${hi} high`;
    case 3: return `Three ${plural(t[0])}`;
    case 2: return `Two pair, ${plural(t[0])} and ${plural(t[2])}`;
    case 1: return `Pair of ${plural(t[0])}`;
    default: return `${hi} high`;
  }
}

export function combos(arr, k) {
  const out = [];
  const pick = [];
  const rec = (start) => {
    if (pick.length === k) { out.push(pick.slice()); return; }
    for (let i = start; i <= arr.length - (k - pick.length); i++) {
      pick.push(arr[i]);
      rec(i + 1);
      pick.pop();
    }
  };
  rec(0);
  return out;
}

// How hole cards may be used:
//   'any'   - 0, 1 or 2 hole cards with 5, 4 or 3 board cards (Hold'em, 5-Card Any)
//   'exact' - exactly 2 hole cards and exactly 3 board cards (Omaha, Pineapple)
const idxCache = new Map();
function idxCombos(n, k) {
  const key = n * 8 + k;
  if (!idxCache.has(key)) idxCache.set(key, combos(Array.from({ length: n }, (_, i) => i), k));
  return idxCache.get(key);
}
const holeCounts = (mode) => (mode === 'exact' ? [2] : [0, 1, 2]);

export function bestHand(hole, board, mode) {
  let best = null;
  for (const h of holeCounts(mode)) {
    if (h > hole.length || 5 - h > board.length) continue;
    for (const hi of idxCombos(hole.length, h)) {
      for (const bi of idxCombos(board.length, 5 - h)) {
        const five = [...hi.map((i) => hole[i]), ...bi.map((i) => board[i])];
        const score = evaluate5(five);
        if (!best || score > best.score) best = { score, cards: five };
      }
    }
  }
  return best;
}
export const bestHoldem = (hole, board) => bestHand(hole, board, 'any');
export const bestOmaha = (hole, board) => bestHand(hole, board, 'exact');

// Same as bestHand but on integer cards and returning only the score. board must have 5 cards.
export function bestScoreI(hole, board, mode) {
  let best = 0;
  const n = hole.length;
  if (mode !== 'exact') {
    best = eval5i(board[0], board[1], board[2], board[3], board[4]);
    for (let i = 0; i < n; i++) {
      for (let x = 0; x < 5; x++) { // leave out board card x
        const s = eval5i(hole[i], board[x === 0 ? 1 : 0], board[x <= 1 ? 2 : 1], board[x <= 2 ? 3 : 2], board[x <= 3 ? 4 : 3]);
        if (s > best) best = s;
      }
    }
  }
  const triples = idxCombos(5, 3);
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = 0; k < 10; k++) {
        const t = triples[k];
        const s = eval5i(hole[i], hole[j], board[t[0]], board[t[1]], board[t[2]]);
        if (s > best) best = s;
      }
    }
  }
  return best;
}

export const playMode = (rules) => (rules.hole === 2 || rules.free ? 'any' : 'exact');
export const needsDiscard = (rules) => rules.hole === 5 && !rules.free;
export function variantName(rules) {
  if (rules.hole === 2) return "Hold'em";
  if (rules.hole === 4) return 'Omaha';
  return rules.free ? '5-Card Any' : 'Pineapple Omaha';
}

// ---------- rules, deck limits, pots ----------

// Built-in games. Picking one sets these rules (the stake and win % are left alone).
// Every preset has Carryover on; it can still be switched off, which makes it a custom game.
export const PRESETS = [
  { id: 'tiffany', name: 'Tiffany Day', rules: { hole: 5, free: false, discardTiming: 'post', layout: 'crossword', carryover: true } },
  { id: 'keep', name: "Keep 'Em All", rules: { hole: 5, free: true, layout: 'crossword', carryover: true } },
  { id: 'classic', name: 'Crossword Classic', rules: { hole: 4, free: false, layout: 'crossword', carryover: true } },
  { id: 'omaha', name: 'Omaha Slots', rules: { hole: 4, free: false, layout: 'slots', boards: 5, carryover: true } },
  { id: 'texas', name: 'Texas Crossword', rules: { hole: 2, free: false, layout: 'crossword', carryover: true } },
  { id: 'holdem', name: "Hold'em Slots", rules: { hole: 2, free: false, layout: 'slots', boards: 5, carryover: true } },
];
export const presetById = (id) => PRESETS.find((p) => p.id === id) || null;
// The preset these rules match exactly, or null when they are a custom mix.
export function presetOf(rules) {
  const hit = PRESETS.find((p) => Object.keys(p.rules).every((k) => rules[k] === p.rules[k]));
  return hit ? hit.id : null;
}

export const DEFAULT_RULES = {
  hole: 4,              // 2 Hold'em, 4 Omaha, 5 Pineapple Omaha or 5-Card Any
  free: false,          // 5 cards only: keep all five and use 0-2 of them (no discard)
  showOdds: true,       // show live win percentages
  discardTiming: 'pre', // 'pre' = before the flop, 'post' = after the flop (5 cards only)
  layout: 'slots',      // 'slots' | 'crossword'
  boards: 5,            // slots only: boards wanted (1-5)
  stakeCents: 200,
  carryover: false,
};

export function money(cents) {
  const neg = cents < 0;
  const a = Math.abs(cents);
  const s = a % 100 === 0 ? String(a / 100) : (a / 100).toFixed(2);
  return (neg ? '-$' : '$') + s;
}

export function boardLabel(layout, i) {
  if (layout === 'crossword') return i < 5 ? `${i + 1} Across` : `${i - 4} Down`;
  return `Board ${i + 1}`;
}

// total split into n parts; leftover cents go to the earliest parts.
export function splitEven(total, n) {
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

// The Pocket (Carryover hand) takes whatever is left in the deck, up to 5 cards, and needs at least 2.
export const POCKET_MIN = 2;
export const POCKET_MAX = 5;

export function crosswordMaxPlayers(hole, carryover) {
  return Math.floor((52 - 25 - (carryover ? POCKET_MIN : 0)) / hole);
}

// Decide whether a game can be dealt and what shape it takes.
// carry: array of 10 pending carryover amounts by board position.
export function planGame(rules, nPlayers, carry = []) {
  const h = rules.hole;
  const co = !!rules.carryover;
  const holeCards = nPlayers * h;
  const reserve = co ? POCKET_MIN : 0;
  const notes = [];
  const fail = (reason) => ({ ok: false, reason, notes });
  if (nPlayers < 2) return fail('Need at least 2 players. Add a CPU player to play solo.');
  if (!(rules.stakeCents >= 1)) return fail('Set a stake above $0.');
  let rows;
  let nBoards;
  if (rules.layout === 'crossword') {
    const max = crosswordMaxPlayers(h, co);
    if (nPlayers > max) {
      return fail(`Crossword with ${h} cards${co ? ' and Carryover' : ''} maxes out at ${max} players. You have ${nPlayers}.`);
    }
    rows = 5;
    nBoards = 10;
  } else {
    const fit = Math.floor((52 - holeCards - reserve) / 5);
    if (fit < 1) {
      return fail(`${nPlayers} players with ${h} cards each${co ? ' plus the Pocket' : ''} leaves no room in the deck for even one board.`);
    }
    rows = Math.min(rules.boards, fit, 5);
    nBoards = rows;
    if (rows < rules.boards) {
      notes.push(`The deck is short with ${nPlayers} players, so this round plays ${rows} board${rows === 1 ? '' : 's'} instead of ${rules.boards}.`);
    }
    for (let i = nBoards; i < 10; i++) {
      if (carry[i] > 0) {
        return fail(`${money(carry[i])} is carried over on ${boardLabel('slots', i)}, but only ${nBoards} board${nBoards === 1 ? '' : 's'} can be played right now. ${rows < rules.boards ? 'Remove a player so that board fits.' : ''}`.trim());
      }
    }
  }
  const pocket = co ? Math.min(POCKET_MAX, 52 - rows * 5 - holeCards) : 0;
  if (co && pocket < POCKET_MAX) notes.push(`The Pocket gets ${pocket} cards this round: that is all the deck has left.`);
  const cards = rows * 5 + holeCards + pocket;
  const burn = cards + 1 <= 52;
  if (!burn) notes.push('No burn card this round: the deck has no room for it.');
  const perPlayer = rules.stakeCents * (rules.layout === 'crossword' ? 2 : 1);
  const total = perPlayer * nPlayers;
  const base = splitEven(total, nBoards);
  if (total % nBoards !== 0) {
    notes.push(`${money(total)} doesn't split evenly over ${nBoards} boards, so the extra cents go to the lowest-numbered boards.`);
  }
  const pots = base.map((b, i) => b + (carry[i] || 0));
  return { ok: true, notes, rows, nBoards, burn, pocket, cardsUsed: cards + (burn ? 1 : 0), perPlayer, total, base, pots };
}

// Deal a whole game from an already shuffled deck.
export function dealGame(rules, plan, playerIds, deck) {
  let i = 0;
  const hole = {};
  for (const id of playerIds) { hole[id] = deck.slice(i, i + rules.hole); i += rules.hole; }
  let carryHole = null;
  if (plan.pocket) { carryHole = deck.slice(i, i + plan.pocket); i += plan.pocket; }
  let burn = null;
  if (plan.burn) burn = deck[i++];
  const grid = Array.from({ length: plan.rows }, () => Array(5).fill(null));
  for (let r = 0; r < plan.rows; r++) for (let c = 0; c < 3; c++) grid[r][c] = deck[i++]; // flop
  for (let r = 0; r < plan.rows; r++) grid[r][3] = deck[i++]; // turn
  for (let r = 0; r < plan.rows; r++) grid[r][4] = deck[i++]; // river
  return { hole, carryHole, burn, grid, used: i };
}

// Board card lists in payout order. Rows first; crossword adds the 5 columns.
export function boardsOf(grid, layout) {
  const list = grid.map((row) => row.slice());
  if (layout === 'crossword') {
    for (let c = 0; c < 5; c++) list.push(grid.map((row) => row[c]));
  }
  return list;
}

// Pay every board. hands: [{id, cards}] in seat order, Carryover hand (if any) last.
export function resolveBoards(boards, pots, hands, mode) {
  const deltas = {};
  for (const h of hands) deltas[h.id] = 0;
  const results = boards.map((board, i) => {
    const scored = hands.map((h) => ({ id: h.id, ...bestHand(h.cards, board, mode) }));
    const top = Math.max(...scored.map((s) => s.score));
    const winners = scored.filter((s) => s.score === top);
    const shares = splitEven(pots[i], winners.length);
    winners.forEach((w, k) => { w.cents = shares[k]; deltas[w.id] += shares[k]; });
    return {
      index: i,
      pot: pots[i],
      score: top,
      handName: handName(top),
      winners: winners.map((w) => ({ id: w.id, cents: w.cents, cards: w.cards })),
      all: scored.slice().sort((x, y) => y.score - x.score).map((x) => ({ id: x.id, score: x.score, cards: x.cards })),
    };
  });
  return { results, deltas };
}

// ---------- automatic discard (CPU players and the Carryover hand) ----------

function preflopValue(four) {
  let v = 0;
  for (const c of four) v += rv(c) * 0.6;
  for (const [a, b] of combos(four, 2)) {
    const x = rv(a), y = rv(b);
    if (x === y) v += 6 + x * 0.5;
    if (a[1] === b[1]) v += 3 + Math.max(x, y) * 0.15;
    const gap = Math.abs(x - y);
    if (gap >= 1 && gap <= 3) v += 3 - gap * 0.7;
  }
  const ranks = new Map();
  const suits = new Map();
  for (const c of four) {
    ranks.set(c[0], (ranks.get(c[0]) || 0) + 1);
    suits.set(c[1], (suits.get(c[1]) || 0) + 1);
  }
  for (const n of ranks.values()) if (n >= 3) v -= 8;
  for (const n of suits.values()) if (n >= 3) v -= 2 * (n - 2);
  return v;
}

// Returns the index (0-4) of the card to throw away from a 5-card hand.
// visibleBoards: arrays of face-up cards per board; only boards showing 3+ cards count.
export function autoDiscard(hole5, visibleBoards = []) {
  const live = visibleBoards.filter((b) => b.length >= 3);
  let bestIdx = 0;
  let bestVal = -Infinity;
  for (let i = 0; i < hole5.length; i++) {
    const keep = hole5.filter((_, k) => k !== i);
    let v = preflopValue(keep) / 1000;
    for (const b of live) v += bestOmaha(keep, b).score / CAT;
    if (v > bestVal) { bestVal = v; bestIdx = i; }
  }
  return bestIdx;
}

// ---------- settle up ----------

// balances: [{id, name, cents}] summing to zero. Returns [{from, to, cents}] (names).
export function settleUp(balances) {
  const debt = balances.filter((b) => b.cents < 0).map((b) => ({ name: b.name, cents: -b.cents }));
  const cred = balances.filter((b) => b.cents > 0).map((b) => ({ name: b.name, cents: b.cents }));
  const out = [];
  debt.sort((a, b) => b.cents - a.cents);
  cred.sort((a, b) => b.cents - a.cents);
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const amt = Math.min(debt[i].cents, cred[j].cents);
    out.push({ from: debt[i].name, to: cred[j].name, cents: amt });
    debt[i].cents -= amt;
    cred[j].cents -= amt;
    if (debt[i].cents === 0) i++;
    if (cred[j].cents === 0) j++;
  }
  return out;
}
