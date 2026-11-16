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

// Score for exactly 5 cards. Higher is better; equal scores are an exact tie.
export function evaluate5(cards) {
  const vals = cards.map(rv).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  let straightHigh = 0;
  if (groups.length === 5) {
    if (vals[0] - vals[4] === 4) straightHigh = vals[0];
    else if (vals[0] === 14 && vals[1] === 5 && vals[4] === 2) straightHigh = 5; // wheel
  }
  let cat;
  let tb;
  if (straightHigh) {
    cat = flush ? 8 : 4;
    tb = [straightHigh, 0, 0, 0, 0];
  } else {
    const shape = groups.map((g) => g[1]).join('');
    if (shape === '41') cat = 7;
    else if (shape === '32') cat = 6;
    else if (flush) cat = 5;
    else if (shape === '311') cat = 3;
    else if (shape === '221') cat = 2;
    else if (shape === '2111') cat = 1;
    else cat = 0;
    tb = [];
    for (const [v, n] of groups) for (let i = 0; i < n; i++) tb.push(v);
  }
  let score = cat;
  for (const v of tb) score = score * B + v;
  return score;
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

// Hold'em: best 5 from hole + board, any combination.
export function bestHoldem(hole, board) {
  let best = null;
  for (const five of combos([...hole, ...board], 5)) {
    const score = evaluate5(five);
    if (!best || score > best.score) best = { score, cards: five };
  }
  return best;
}

// Omaha: exactly 2 hole cards and exactly 3 board cards.
export function bestOmaha(hole, board) {
  let best = null;
  const boards3 = combos(board, 3);
  for (const two of combos(hole, 2)) {
    for (const three of boards3) {
      const five = [...two, ...three];
      const score = evaluate5(five);
      if (!best || score > best.score) best = { score, cards: five };
    }
  }
  return best;
}

export function bestHand(hole, board, holeCount) {
  return holeCount === 2 ? bestHoldem(hole, board) : bestOmaha(hole, board);
}

// ---------- rules, deck limits, pots ----------

export const DEFAULT_RULES = {
  hole: 4,              // 2 Hold'em, 4 Omaha, 5 Pineapple Omaha
  discardTiming: 'pre', // 'pre' = before the flop, 'post' = after the flop (5 cards only)
  layout: 'slots',      // 'slots' | 'crossword'
  boards: 5,            // slots only: boards wanted (1-5)
  stakeCents: 200,
  carryover: false,
};

export const HOLE_NAMES = { 2: "Hold'em", 4: 'Omaha', 5: 'Pineapple Omaha' };

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

export function crosswordMaxPlayers(hole, carryover) {
  return Math.floor((52 - 25 - (carryover ? hole : 0)) / hole);
}

// Decide whether a game can be dealt and what shape it takes.
// carry: array of 10 pending carryover amounts by board position.
export function planGame(rules, nPlayers, carry = []) {
  const h = rules.hole;
  const co = !!rules.carryover;
  const holeCards = nPlayers * h + (co ? h : 0);
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
    const fit = Math.floor((52 - holeCards) / 5);
    if (fit < 1) {
      return fail(`${nPlayers} players with ${h} cards each${co ? ' plus the Carryover hand' : ''} leaves no room in the deck for even one board.`);
    }
    rows = Math.min(rules.boards, fit, 5);
    nBoards = rows;
    if (rows < rules.boards) {
      notes.push(`The deck is short with ${nPlayers} players, so this game plays ${rows} board${rows === 1 ? '' : 's'} instead of ${rules.boards}.`);
    }
    for (let i = nBoards; i < 10; i++) {
      if (carry[i] > 0) {
        return fail(`${money(carry[i])} is carried over on ${boardLabel('slots', i)}, but only ${nBoards} board${nBoards === 1 ? '' : 's'} can be played right now. ${rows < rules.boards ? 'Remove a player so that board fits.' : ''}`.trim());
      }
    }
  }
  const cards = rows * 5 + holeCards;
  const burn = cards + 1 <= 52;
  if (!burn) notes.push('No burn card this game: the deck has no room for it.');
  const perPlayer = rules.stakeCents * (rules.layout === 'crossword' ? 2 : 1);
  const total = perPlayer * nPlayers;
  const base = splitEven(total, nBoards);
  if (total % nBoards !== 0) {
    notes.push(`${money(total)} doesn't split evenly over ${nBoards} boards, so the extra cents go to the lowest-numbered boards.`);
  }
  const pots = base.map((b, i) => b + (carry[i] || 0));
  return { ok: true, notes, rows, nBoards, burn, cardsUsed: cards + (burn ? 1 : 0), perPlayer, total, base, pots };
}

// Deal a whole game from an already shuffled deck.
export function dealGame(rules, plan, playerIds, deck) {
  let i = 0;
  const hole = {};
  for (const id of playerIds) { hole[id] = deck.slice(i, i + rules.hole); i += rules.hole; }
  let carryHole = null;
  if (rules.carryover) { carryHole = deck.slice(i, i + rules.hole); i += rules.hole; }
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
export function resolveBoards(boards, pots, hands, holeCount) {
  const deltas = {};
  for (const h of hands) deltas[h.id] = 0;
  const results = boards.map((board, i) => {
    const scored = hands.map((h) => ({ id: h.id, ...bestHand(h.cards, board, holeCount) }));
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
