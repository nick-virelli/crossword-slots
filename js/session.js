// Crossword Slots — session state machine. Runs on the host's phone only.
// The state is a plain JSON object so it can be saved and restored.

import {
  CARRY_ID, DEFAULT_RULES, makeDeck, shuffle, planGame, dealGame, boardsOf,
  resolveBoards, autoDiscard, settleUp, splitEven, boardLabel,
} from './engine.js';

const STAGE_COLS = { pre: 0, flop: 3, turn: 4, river: 5, showdown: 5, done: 5 };

export function newSession(code, hostId, hostName) {
  return {
    v: 1,
    code,
    hostId,
    players: [{ id: hostId, name: hostName, bot: false, active: true, balance: 0 }],
    rules: { ...DEFAULT_RULES },
    carry: Array(10).fill(0),
    phase: 'lobby', // lobby | play | ended
    game: null,
    gameNo: 0,
    botSeq: 0,
    refund: null,
    settle: null,
  };
}

const activePlayers = (s) => s.players.filter((p) => p.active);
export const carryLocked = (s) => s.carry.some((c) => c > 0);
export const inProgress = (s) => s.phase === 'play' && s.game && s.game.stage !== 'done';
const err = (error) => ({ error });
const OK = { ok: true };

export function addPlayer(s, id, name, bot = false) {
  if (s.phase === 'ended') return err('This session has ended.');
  const clean = String(name || '').trim().slice(0, 16) || 'Player';
  const p = s.players.find((x) => x.id === id);
  if (p) { p.name = clean; p.active = true; return OK; }
  s.players.push({ id, name: clean, bot, active: true, balance: 0 });
  return OK;
}

export function addBot(s) {
  s.botSeq += 1;
  return addPlayer(s, `bot${s.botSeq}`, `CPU ${s.botSeq}`, true);
}

export function removePlayer(s, id) {
  if (id === s.hostId) return err("The host can't leave. End the session instead.");
  if (inProgress(s) && s.game.order.includes(id)) return err('Wait until this game finishes.');
  const p = s.players.find((x) => x.id === id);
  if (!p) return OK;
  const played = s.game && s.game.order.includes(id);
  if (p.balance === 0 && !played) s.players = s.players.filter((x) => x.id !== id);
  else p.active = false; // keep them in the ledger for settle-up
  return OK;
}

export function setRules(s, patch) {
  if (s.phase !== 'lobby') return err('Rules can only change between games.');
  if (carryLocked(s)) return err('Rules are locked until the carryover pot has been played out.');
  const r = { ...s.rules };
  if ([2, 4, 5].includes(patch.hole)) r.hole = patch.hole;
  if (['pre', 'post'].includes(patch.discardTiming)) r.discardTiming = patch.discardTiming;
  if (['slots', 'crossword'].includes(patch.layout)) r.layout = patch.layout;
  if ([1, 2, 3, 4, 5].includes(patch.boards)) r.boards = patch.boards;
  if (Number.isFinite(patch.stakeCents)) r.stakeCents = Math.max(1, Math.min(1000000, Math.round(patch.stakeCents)));
  if (typeof patch.carryover === 'boolean') r.carryover = patch.carryover;
  s.rules = r;
  return OK;
}

function visibleBoards(g) {
  const cols = STAGE_COLS[g.stage];
  const rows = g.grid.map((row) => row.slice(0, cols));
  if (g.rules.layout !== 'crossword') return rows;
  const down = [];
  for (let c = 0; c < cols; c++) down.push(g.grid.map((row) => row[c]));
  return [...rows, ...down];
}

const discardStage = (g) => (g.rules.discardTiming === 'pre' ? 'pre' : 'flop');
const discardOpen = (g) => g.rules.hole === 5 && g.stage === discardStage(g);
const pendingDiscards = (g) => (discardOpen(g) ? g.order.filter((id) => g.discard[id] === undefined) : []);

function openDiscards(s) {
  const g = s.game;
  const vis = visibleBoards(g);
  for (const id of g.order) {
    const p = s.players.find((x) => x.id === id);
    if (p && p.bot) g.discard[id] = autoDiscard(g.hole[id], vis);
  }
  if (g.carryHole) g.carryDiscard = autoDiscard(g.carryHole, vis);
}

export function deal(s, rnd) {
  if (s.phase === 'ended') return err('This session has ended.');
  if (inProgress(s)) return err('A game is already running.');
  const players = activePlayers(s);
  const plan = planGame(s.rules, players.length, s.carry);
  if (!plan.ok) return err(plan.reason);
  const order = players.map((p) => p.id);
  const d = dealGame(s.rules, plan, order, shuffle(makeDeck(), rnd));
  s.gameNo += 1;
  s.game = {
    no: s.gameNo,
    rules: { ...s.rules },
    plan,
    carryIn: s.carry.slice(0, plan.nBoards),
    order,
    hole: d.hole,
    carryHole: d.carryHole,
    burn: d.burn,
    grid: d.grid,
    discard: {},
    carryDiscard: undefined,
    stage: 'pre',
    payIndex: 0,
    results: null,
    net: null,
  };
  s.phase = 'play';
  if (discardOpen(s.game)) openDiscards(s);
  return OK;
}

export function discard(s, id, idx) {
  const g = s.game;
  if (!g || s.phase !== 'play' || !discardOpen(g)) return err('No discard is open right now.');
  if (!g.order.includes(id)) return err("You're not in this game.");
  if (g.discard[id] !== undefined) return err('You already discarded.');
  if (!Number.isInteger(idx) || idx < 0 || idx > 4) return err('Pick one of your five cards.');
  g.discard[id] = idx;
  return OK;
}

export function autoDiscardRest(s) {
  const g = s.game;
  if (!g || !discardOpen(g)) return OK;
  const vis = visibleBoards(g);
  for (const id of pendingDiscards(g)) g.discard[id] = autoDiscard(g.hole[id], vis);
  return OK;
}

const keptCards = (hole, idx) => (idx === undefined ? hole : hole.filter((_, k) => k !== idx));

function showdown(s) {
  const g = s.game;
  const hands = g.order.map((id) => ({ id, cards: keptCards(g.hole[id], g.discard[id]) }));
  if (g.carryHole) hands.push({ id: CARRY_ID, cards: keptCards(g.carryHole, g.carryDiscard) });
  const boards = boardsOf(g.grid, g.rules.layout);
  const { results, deltas } = resolveBoards(boards, g.plan.pots, hands, g.rules.hole);
  g.results = results;
  g.net = {};
  for (const id of g.order) {
    g.net[id] = deltas[id] - g.plan.perPlayer;
    s.players.find((p) => p.id === id).balance += g.net[id];
  }
  const carry = Array(10).fill(0);
  for (const r of results) {
    for (const w of r.winners) if (w.id === CARRY_ID) carry[r.index] += w.cents;
  }
  s.carry = carry;
  g.stage = 'showdown';
  g.payIndex = 1;
}

// The host's single "next" button.
export function advance(s) {
  const g = s.game;
  if (!g || s.phase !== 'play') return err('No game is running.');
  if (pendingDiscards(g).length) return err('Still waiting for discards.');
  switch (g.stage) {
    case 'pre':
      g.stage = 'flop';
      if (discardOpen(g)) openDiscards(s);
      return OK;
    case 'flop': g.stage = 'turn'; return OK;
    case 'turn': g.stage = 'river'; return OK;
    case 'river': showdown(s); return OK;
    case 'showdown':
      if (g.payIndex < g.plan.nBoards) g.payIndex += 1;
      else g.stage = 'done';
      return OK;
    default: return err('This game is over.');
  }
}

export function toLobby(s) {
  if (s.phase === 'ended') return err('This session has ended.');
  if (inProgress(s)) return err('Finish this game first.');
  s.phase = 'lobby';
  return OK;
}

export function endSession(s) {
  if (s.phase === 'ended') return OK;
  if (inProgress(s)) return err('Finish this game first.');
  const total = s.carry.reduce((a, b) => a + b, 0);
  if (total > 0) {
    // Carried chips must never be lost: hand them back to the players of the last game.
    const ids = s.game ? s.game.order : activePlayers(s).map((p) => p.id);
    const shares = splitEven(total, ids.length);
    ids.forEach((id, k) => { s.players.find((p) => p.id === id).balance += shares[k]; });
    s.refund = { total, count: ids.length };
    s.carry = Array(10).fill(0);
  }
  s.settle = settleUp(s.players.map((p) => ({ id: p.id, name: p.name, cents: p.balance })));
  s.phase = 'ended';
  return OK;
}

// What one player's phone is allowed to see.
export function viewFor(s, pid, online = new Set()) {
  const g = s.game;
  const nameOf = (id) => (id === CARRY_ID ? 'Carryover hand' : (s.players.find((p) => p.id === id) || {}).name || '?');
  const paying = g && g.stage === 'showdown';
  const unpaid = (id) => {
    if (!paying) return 0;
    let sum = 0;
    for (const r of g.results) {
      if (r.index >= g.payIndex) for (const w of r.winners) if (w.id === id) sum += w.cents;
    }
    return sum;
  };
  const pending = g ? pendingDiscards(g) : [];
  const view = {
    code: s.code,
    phase: s.phase,
    hostId: s.hostId,
    you: pid,
    rules: s.rules,
    locked: carryLocked(s),
    plan: null,
    carry: s.carry.map((c, i) => (paying && i >= g.payIndex ? g.carryIn[i] || 0 : c)),
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      bot: p.bot,
      active: p.active,
      balance: p.balance - unpaid(p.id),
      online: p.bot || online.has(p.id),
      inGame: !!g && s.phase === 'play' && g.order.includes(p.id),
      waiting: pending.includes(p.id),
    })),
    game: null,
    settle: s.settle,
    refund: s.refund,
  };
  const plan = planGame(s.rules, activePlayers(s).length, s.carry);
  view.plan = plan.ok
    ? { ok: true, notes: plan.notes, rows: plan.rows, nBoards: plan.nBoards, perPlayer: plan.perPlayer, total: plan.total, base: plan.base, pots: plan.pots }
    : { ok: false, reason: plan.reason, notes: plan.notes };
  if (g && s.phase !== 'lobby') {
    const cols = STAGE_COLS[g.stage];
    const shown = g.stage === 'showdown' || g.stage === 'done';
    const mine = g.hole[pid];
    view.game = {
      no: g.no,
      rules: g.rules,
      rows: g.plan.rows,
      nBoards: g.plan.nBoards,
      labels: Array.from({ length: g.plan.nBoards }, (_, i) => boardLabel(g.rules.layout, i)),
      pots: g.plan.pots,
      carryIn: g.carryIn,
      perPlayer: g.plan.perPlayer,
      burned: !!g.burn,
      stage: g.stage,
      grid: g.grid.map((row) => row.map((c, k) => (k < cols ? c : null))),
      myHole: mine || null,
      myDiscard: mine && g.discard[pid] !== undefined ? g.discard[pid] : null,
      needDiscard: pending.includes(pid),
      waitingOn: pending.map(nameOf),
      hasCarryHand: !!g.carryHole,
      payIndex: g.payIndex,
      hands: null,
      results: null,
      net: null,
    };
    if (shown) {
      view.game.hands = g.order.map((id) => ({ id, name: nameOf(id), cards: keptCards(g.hole[id], g.discard[id]) }));
      if (g.carryHole) view.game.hands.push({ id: CARRY_ID, name: nameOf(CARRY_ID), cards: keptCards(g.carryHole, g.carryDiscard) });
      const upTo = g.stage === 'done' ? g.plan.nBoards : g.payIndex;
      view.game.results = g.results.slice(0, upTo).map((r) => ({
        index: r.index,
        label: boardLabel(g.rules.layout, r.index),
        pot: r.pot,
        handName: r.handName,
        winners: r.winners.map((w) => ({ id: w.id, name: nameOf(w.id), cents: w.cents, cards: w.cards })),
      }));
      if (g.stage === 'done') view.game.net = g.order.map((id) => ({ id, name: nameOf(id), cents: g.net[id] }));
    }
  }
  return view;
}
