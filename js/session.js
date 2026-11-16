// Crossword Slots — session state machine. Runs on the host's phone only.
// The state is a plain JSON object so it can be saved, restored and handed to a new host.
//
// A "device" is a phone (did). A "player" is a name with a balance (id). Phones check in
// as a player and can switch, so a player's seat and balance never depend on one phone.

import {
  CARRY_ID, DEFAULT_RULES, makeDeck, shuffle, planGame, dealGame, boardsOf, resolveBoards,
  autoDiscard, settleUp, splitEven, boardLabel, playMode, needsDiscard, variantName, handName,
} from './engine.js?v=1794812783';
import { computeOdds } from './odds.js?v=1794812783';

const STAGE_COLS = { pre: 0, flop: 3, turn: 4, river: 5, showdown: 5, done: 5 };
export const POCKET_NAME = 'The Pocket';

export function newSession(code, hostDid, hostName) {
  const s = {
    v: 2,
    code,
    startedAt: Date.now(),
    hostId: null,
    hostDid,
    players: [],
    devices: {},
    seq: 0,
    botSeq: 0,
    rules: { ...DEFAULT_RULES },
    carry: Array(10).fill(0),
    phase: 'lobby', // lobby | play | ended
    game: null,
    gameNo: 0,
    log: [],
    refund: null,
    settle: null,
  };
  s.hostId = addPlayer(s, hostName, false);
  s.devices[hostDid] = s.hostId;
  return s;
}

const cleanName = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
const byId = (s, id) => s.players.find((p) => p.id === id);
const playing = (s) => s.players.filter((p) => p.active && !p.sitOut);
export const carryLocked = (s) => s.carry.some((c) => c > 0);
export const inProgress = (s) => s.phase === 'play' && !!s.game && s.game.stage !== 'done';
export const playerOf = (s, did) => s.devices[did] || null;
export const deviceOf = (s, id) => Object.keys(s.devices).find((d) => s.devices[d] === id) || null;
const err = (error) => ({ error });
const OK = { ok: true };

export function addPlayer(s, name, bot = false) {
  s.seq += 1;
  const id = `${bot ? 'b' : 'p'}${s.seq}`;
  s.players.push({ id, name: cleanName(name) || 'Player', bot, active: true, sitOut: false, played: false, balance: 0 });
  return id;
}

export function addBot(s) {
  if (s.phase === 'ended') return err('This session has ended.');
  s.botSeq += 1;
  addPlayer(s, `CPU ${s.botSeq}`, true);
  return OK;
}

// A phone stops being a player. A name that never played and holds no chips disappears.
function release(s, did) {
  const id = s.devices[did];
  if (!id) return;
  delete s.devices[did];
  const p = byId(s, id);
  const inGame = inProgress(s) && s.game.order.includes(id);
  if (p && !p.played && p.balance === 0 && !inGame && id !== s.hostId) {
    s.players = s.players.filter((x) => x.id !== id);
  }
}

// A phone checks in: as an existing player (pick.id) or by name (pick.name).
export function claim(s, did, pick) {
  if (s.phase === 'ended') return err('This session has ended.');
  if (did === s.hostDid) return err('The host stays as the host. Pass the host to someone else first.');
  let p = null;
  if (pick && pick.id) {
    p = byId(s, pick.id);
    if (!p || p.bot) return err("That player isn't in this room.");
  } else {
    const name = cleanName(pick && pick.name);
    if (!name) return err('Type your name first.');
    p = s.players.find((x) => !x.bot && x.name.toLowerCase() === name.toLowerCase());
    if (!p) {
      release(s, did);
      const id = addPlayer(s, name, false);
      s.devices[did] = id;
      return { ok: true, id };
    }
  }
  if (p.id === s.hostId) return err('That name belongs to the host.');
  if (s.devices[did] === p.id) return { ok: true, id: p.id };
  release(s, did);
  for (const d of Object.keys(s.devices)) if (s.devices[d] === p.id) delete s.devices[d]; // one phone per player
  s.devices[did] = p.id;
  p.active = true;
  return { ok: true, id: p.id };
}

// "I picked the wrong name": back to the who-are-you list without leaving the room.
export function unclaim(s, did) {
  if (did === s.hostDid) return err('The host stays as the host.');
  release(s, did);
  return OK;
}

export function removePlayer(s, id) {
  if (id === s.hostId) return err("The host can't leave. Pass the host or end the session instead.");
  if (inProgress(s) && s.game.order.includes(id)) return err('Wait until this game finishes.');
  const p = byId(s, id);
  if (!p) return OK;
  for (const d of Object.keys(s.devices)) if (s.devices[d] === id) delete s.devices[d];
  if (p.balance === 0 && !p.played) s.players = s.players.filter((x) => x.id !== id);
  else p.active = false; // keep them in the ledger for settle-up
  return OK;
}

export function setSitOut(s, id, on) {
  const p = byId(s, id);
  if (!p) return err("That player isn't in this room.");
  p.sitOut = !!on;
  return OK;
}

export function passHost(s, toId) {
  const p = byId(s, toId);
  const did = deviceOf(s, toId);
  if (!p || p.bot || !did) return err('They need to be in the room on their phone to become host.');
  s.hostId = toId;
  s.hostDid = did;
  return OK;
}

export function setRules(s, patch) {
  if (s.phase !== 'lobby') return err('Rules can only change between games.');
  if (typeof patch.showOdds === 'boolean') { // a display setting, never locked
    s.rules = { ...s.rules, showOdds: patch.showOdds };
    return OK;
  }
  if (carryLocked(s)) return err('Rules are locked until the carryover pot has been played out.');
  const r = { ...s.rules };
  if ([2, 4, 5].includes(patch.hole)) { r.hole = patch.hole; r.free = patch.hole === 5 && !!patch.free; }
  if (['pre', 'post'].includes(patch.discardTiming)) r.discardTiming = patch.discardTiming;
  if (['slots', 'crossword'].includes(patch.layout)) r.layout = patch.layout;
  if ([1, 2, 3, 4, 5].includes(patch.boards)) r.boards = patch.boards;
  if (Number.isFinite(patch.stakeCents)) r.stakeCents = Math.max(1, Math.min(1000000, Math.round(patch.stakeCents)));
  if (typeof patch.carryover === 'boolean') r.carryover = patch.carryover;
  s.rules = r;
  return OK;
}

// Win percentages always show when the host is the only human; otherwise the host decides.
export function oddsOn(s) {
  return s.rules.showOdds || playing(s).filter((p) => !p.bot).length <= 1;
}

function knownBoards(g) {
  const cols = STAGE_COLS[g.stage];
  const rows = g.grid.map((row) => row.slice(0, cols));
  if (g.rules.layout !== 'crossword') return rows;
  const down = [];
  for (let c = 0; c < 5; c++) down.push(c < cols ? g.grid.map((row) => row[c]) : []);
  return [...rows, ...down];
}

const discardStage = (g) => (g.rules.discardTiming === 'pre' ? 'pre' : 'flop');
const discardOpen = (g) => needsDiscard(g.rules) && g.stage === discardStage(g);
const pendingDiscards = (g) => (discardOpen(g) ? g.order.filter((id) => g.discard[id] === undefined) : []);
const discardsDone = (g) => !needsDiscard(g.rules) || g.order.every((id) => g.discard[id] !== undefined);
const keptCards = (hole, idx) => (idx === undefined ? hole : hole.filter((_, k) => k !== idx));

function handsOf(g) {
  const hands = g.order.map((id) => ({ id, cards: keptCards(g.hole[id], g.discard[id]) }));
  if (g.carryHole) hands.push({ id: CARRY_ID, cards: keptCards(g.carryHole, g.carryDiscard) });
  return hands;
}

function refreshOdds(s, rnd) {
  const g = s.game;
  if (!g || !['pre', 'flop', 'turn', 'river'].includes(g.stage)) return;
  g.odds = null;
  if (!oddsOn(s) || !discardsDone(g)) return; // Pineapple: wait until everyone has discarded
  const cols = STAGE_COLS[g.stage];
  const gone = new Set([...Object.values(g.hole).flat(), ...(g.carryHole || []), ...g.grid.flatMap((row) => row.slice(0, cols))]);
  if (g.burn) gone.add(g.burn);
  const unseen = makeDeck().filter((c) => !gone.has(c));
  const boards = computeOdds(handsOf(g), playMode(g.rules), knownBoards(g), unseen, rnd);
  const ev = {};
  boards.forEach((b, i) => { for (const id of Object.keys(b)) ev[id] = (ev[id] || 0) + b[id] * g.plan.pots[i]; });
  g.odds = { boards, ev };
}

function openDiscards(s) {
  const g = s.game;
  const vis = knownBoards(g);
  for (const id of g.order) {
    if (byId(s, id).bot) g.discard[id] = autoDiscard(g.hole[id], vis);
  }
  // the Pocket only discards when it holds a full five, same as the players
  if (g.carryHole && g.carryHole.length === 5) g.carryDiscard = autoDiscard(g.carryHole, vis);
}

export function deal(s, rnd) {
  if (s.phase === 'ended') return err('This session has ended.');
  if (inProgress(s)) return err('A game is already running.');
  const players = playing(s);
  const plan = planGame(s.rules, players.length, s.carry);
  if (!plan.ok) return err(plan.reason);
  const order = players.map((p) => p.id);
  const d = dealGame(s.rules, plan, order, shuffle(makeDeck(), rnd));
  for (const p of players) p.played = true;
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
    odds: null,
  };
  s.phase = 'play';
  if (discardOpen(s.game)) openDiscards(s);
  refreshOdds(s);
  return OK;
}

export function discard(s, id, idx) {
  const g = s.game;
  if (!g || s.phase !== 'play' || !discardOpen(g)) return err('No discard is open right now.');
  if (!g.order.includes(id)) return err("You're not in this game.");
  if (g.discard[id] !== undefined) return err('You already discarded.');
  if (!Number.isInteger(idx) || idx < 0 || idx > 4) return err('Pick one of your five cards.');
  g.discard[id] = idx;
  refreshOdds(s);
  return OK;
}

export function autoDiscardRest(s) {
  const g = s.game;
  if (!g || !discardOpen(g)) return OK;
  const vis = knownBoards(g);
  for (const id of pendingDiscards(g)) g.discard[id] = autoDiscard(g.hole[id], vis);
  refreshOdds(s);
  return OK;
}

function rulesLine(r, rows) {
  const parts = [variantName(r), r.layout === 'crossword' ? 'Crossword' : `Slots × ${rows}`];
  if (r.carryover) parts.push('Carryover');
  return parts.join(' · ');
}

function showdown(s) {
  const g = s.game;
  const boards = boardsOf(g.grid, g.rules.layout);
  const { results, deltas } = resolveBoards(boards, g.plan.pots, handsOf(g), playMode(g.rules));
  g.results = results;
  g.net = {};
  for (const id of g.order) {
    g.net[id] = deltas[id] - g.plan.perPlayer;
    byId(s, id).balance += g.net[id];
  }
  const carry = Array(10).fill(0);
  for (const r of results) {
    for (const w of r.winners) if (w.id === CARRY_ID) carry[r.index] += w.cents;
  }
  s.carry = carry;
  s.log.push({
    no: g.no,
    line: rulesLine(g.rules, g.plan.rows),
    net: g.order.map((id) => ({ name: byId(s, id).name, cents: g.net[id], bot: byId(s, id).bot })),
    online: g.order.filter((id) => !byId(s, id).bot).length >= 2, // only games between people count long-term
    carried: carry.reduce((a, b) => a + b, 0),
  });
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
      break;
    case 'flop': g.stage = 'turn'; break;
    case 'turn': g.stage = 'river'; break;
    case 'river': showdown(s); break;
    case 'showdown':
      if (g.payIndex < g.plan.nBoards) g.payIndex += 1;
      else g.stage = 'done';
      break;
    default: return err('This game is over.');
  }
  refreshOdds(s);
  return OK;
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
    const ids = s.game ? s.game.order : playing(s).map((p) => p.id);
    const shares = splitEven(total, ids.length);
    ids.forEach((id, k) => { byId(s, id).balance += shares[k]; });
    s.refund = {
      total,
      count: ids.length,
      online: ids.filter((id) => !byId(s, id).bot).length >= 2,
      shares: ids.map((id, k) => ({ name: byId(s, id).name, cents: shares[k], bot: byId(s, id).bot })),
    };
    s.carry = Array(10).fill(0);
  }
  s.settle = settleUp(s.players.map((p) => ({ id: p.id, name: p.name, cents: p.balance })));
  s.phase = 'ended';
  return OK;
}

// What one phone is allowed to see. pid is null for a phone that hasn't picked a player yet.
export function viewFor(s, pid, online = new Set(), extra = {}) {
  const g = s.game;
  const nameOf = (id) => (id === CARRY_ID ? POCKET_NAME : (byId(s, id) || {}).name || '?');
  const paying = !!g && g.stage === 'showdown';
  const unpaid = (id) => {
    if (!paying) return 0;
    let sum = 0;
    for (const r of g.results) {
      if (r.index >= g.payIndex) for (const w of r.winners) if (w.id === id) sum += w.cents;
    }
    return sum;
  };
  const pending = g ? pendingDiscards(g) : [];
  const me = pid ? byId(s, pid) : null;
  const view = {
    code: s.code,
    phase: s.phase,
    hostId: s.hostId,
    you: me ? me.id : null,
    sitOut: !!me && me.sitOut,
    rules: s.rules,
    oddsOn: oddsOn(s),
    locked: carryLocked(s),
    plan: null,
    carry: s.carry.map((c, i) => (paying && i >= g.payIndex ? g.carryIn[i] || 0 : c)),
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      bot: p.bot,
      active: p.active,
      sitOut: p.sitOut,
      balance: p.balance - unpaid(p.id),
      online: p.bot || online.has(p.id),
      inGame: !!g && s.phase === 'play' && g.order.includes(p.id),
      waiting: pending.includes(p.id),
    })),
    game: null,
    log: s.log.filter((l) => !paying || l.no !== g.no),
    settle: s.settle,
    refund: s.refund,
    past: extra.past || [],
    totals: extra.totals || [],
    roster: extra.roster || [],
  };
  const plan = planGame(s.rules, playing(s).length, s.carry);
  view.plan = plan.ok
    ? { ok: true, notes: plan.notes, rows: plan.rows, nBoards: plan.nBoards, perPlayer: plan.perPlayer, total: plan.total, base: plan.base, pots: plan.pots }
    : { ok: false, reason: plan.reason, notes: plan.notes };
  if (g && s.phase !== 'lobby') {
    const cols = STAGE_COLS[g.stage];
    const shown = g.stage === 'showdown' || g.stage === 'done';
    const mine = me ? g.hole[me.id] : null;
    const total = g.plan.pots.reduce((a, b) => a + b, 0);
    view.game = {
      no: g.no,
      rules: g.rules,
      rows: g.plan.rows,
      nBoards: g.plan.nBoards,
      labels: Array.from({ length: g.plan.nBoards }, (_, i) => boardLabel(g.rules.layout, i)),
      pots: g.plan.pots,
      carryIn: g.carryIn,
      perPlayer: g.plan.perPlayer,
      stage: g.stage,
      grid: g.grid.map((row) => row.map((c, k) => (k < cols ? c : null))),
      myHole: mine || null,
      myDiscard: mine && g.discard[me.id] !== undefined ? g.discard[me.id] : null,
      needDiscard: !!me && pending.includes(me.id),
      waitingOn: pending.map(nameOf),
      payIndex: g.payIndex,
      odds: null,
      oddsWait: view.oddsOn && !shown && !discardsDone(g),
      hands: null,
      results: null,
      net: null,
    };
    if (view.oddsOn && g.odds) {
      const upTo = shown ? (g.stage === 'done' ? g.plan.nBoards : g.payIndex) : 0;
      view.game.odds = {
        // boards already paid show their real result instead
        boards: g.odds.boards.map((b, i) => (i < upTo ? null : Object.keys(b).map((id) => ({ id, name: nameOf(id), share: b[id] })).sort((x, y) => y.share - x.share))),
        ev: shown ? null : Object.keys(g.odds.ev).map((id) => ({ id, name: nameOf(id), cents: Math.round(g.odds.ev[id]), share: g.odds.ev[id] / total })).sort((x, y) => y.cents - x.cents),
      };
    }
    if (shown) {
      view.game.hands = handsOf(g).map((h) => ({ id: h.id, name: nameOf(h.id), cards: h.cards }));
      const upTo = g.stage === 'done' ? g.plan.nBoards : g.payIndex;
      view.game.results = g.results.slice(0, upTo).map((r) => ({
        index: r.index,
        label: boardLabel(g.rules.layout, r.index),
        pot: r.pot,
        handName: r.handName,
        winners: r.winners.map((w) => ({ id: w.id, name: nameOf(w.id), cents: w.cents, cards: w.cards })),
        all: r.all.map((x) => ({ id: x.id, name: nameOf(x.id), handName: handName(x.score), cards: x.cards })),
      }));
      if (g.stage === 'done') view.game.net = g.order.map((id) => ({ id, name: nameOf(id), cents: g.net[id] }));
    }
  }
  return view;
}
