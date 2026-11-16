import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate5, handName, handCategory, bestHoldem, bestOmaha, bestHand, bestScoreI, toInts, makeDeck,
  shuffle, planGame, dealGame, boardsOf, resolveBoards, splitEven, settleUp, autoDiscard,
  crosswordMaxPlayers, CARRY_ID, DEFAULT_RULES,
} from '../js/engine.js';
import { computeOdds, outlook } from '../js/odds.js';
import {
  newSession, addBot, claim, unclaim, removePlayer, setSitOut, passHost, setRules, deal, discard,
  autoDiscardRest, advance, toLobby, endSession, viewFor, carryLocked, oddsOn, setOption, controller,
  canControl, computeAwards,
} from '../js/session.js';

const h = (s) => s.split(' ');
const ev = (s) => evaluate5(h(s));

// deterministic RNG for repeatable tests
function seeded(seed) {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

// ---------- hand rankings ----------

test('hand categories rank in the right order', () => {
  const ladder = [
    'Ah Kd 9c 5s 3h', // high card
    '2h 2d 9c 5s 3h', // pair
    '2h 2d 3c 3s 4h', // two pair
    '2h 2d 2c 5s 3h', // trips
    'Ah 2d 3c 4s 5h', // wheel straight
    '2h 7h 9h Jh Kh', // flush
    '2h 2d 2c 3s 3h', // full house
    '2h 2d 2c 2s 3h', // quads
    'Ah 2h 3h 4h 5h', // straight flush (wheel)
    'Th Jh Qh Kh Ah', // royal
  ].map(ev);
  for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i] > ladder[i - 1], `rung ${i}`);
  assert.deepEqual(ladder.map(handCategory), [0, 1, 2, 3, 4, 5, 6, 7, 8, 8]);
});

test('kickers and tie-breaks', () => {
  assert.ok(ev('Ah Ad Kc 5s 3h') > ev('Ah Ad Qc Js 9h'));
  assert.ok(ev('Kh Kd 2c 2s 3h') > ev('Qh Qd Jc Js Ah'));
  assert.ok(ev('3h 3d 3c 2s 2h') > ev('2h 2d 2c As Ah'));
  assert.ok(ev('6h 2d 3c 4s 5h') > ev('Ah 2d 3c 4s 5h')); // six-high beats the wheel
  assert.ok(ev('Ah Kd Qc Js Th') > ev('Kh Qd Jc Ts 9h'));
  assert.ok(ev('Ah 9h 7h 5h 3h') > ev('Kd Qd Jd 9d 8d'));
  assert.equal(ev('Ah Kd 9c 5s 3h'), ev('As Kc 9d 5h 3d')); // suits never break ties
  assert.ok(ev('Ah Kd 9c 5s 4h') > ev('Ah Kd 9c 5s 3h'));
  assert.notEqual(handCategory(ev('Qh Kd Ac 2s 3h')), 4); // no wrap-around straights
});

test('hand names', () => {
  assert.equal(handName(ev('Th Jh Qh Kh Ah')), 'Royal flush');
  assert.equal(handName(ev('Kh Kd Kc 2s 2h')), 'Full house, Kings over Twos');
  assert.equal(handName(ev('6h 6d Kc 2s 3h')), 'Pair of Sixes');
  assert.equal(handName(ev('Ah 2d 3c 4s 5h')), 'Straight, Five high');
});

// ---------- Hold'em and Omaha ----------

test("Hold'em uses any combination, including playing the board", () => {
  const board = h('Ts Js Qs Ks As');
  assert.equal(handName(bestHoldem(h('2c 3d'), board).score), 'Royal flush');
  // one hole card is enough for a flush in Hold'em
  assert.equal(handCategory(bestHoldem(h('Ah 2c'), h('Kh 9h 5h 3h 8d')).score), 5);
});

test('Omaha must use exactly two hole cards and three board cards', () => {
  // four hearts on board, one heart in hand: no flush in Omaha
  const r = bestOmaha(h('Ah Kd 2c 3c'), h('Qh 9h 5h 4h 8d'));
  assert.notEqual(handCategory(r.score), 5);
  // a royal flush on the board can't be played
  const r2 = bestOmaha(h('2c 3d 4c 7d'), h('Ts Js Qs Ks As'));
  assert.ok(handCategory(r2.score) < 4);
  // quads on board: only three of them play, with a pocket pair for a full house
  assert.equal(handName(bestOmaha(h('Kc Kd 2c 3d'), h('9s 9h 9d 9c 4s')).score), 'Full house, Nines over Kings');
  // three hole cards of one suit still only count two
  assert.notEqual(handCategory(bestOmaha(h('Ah Kh Qh 2c'), h('Jh Td 5h 4c 8d')).score), 5);
  assert.equal(handCategory(bestOmaha(h('Ah Kh Qh 2c'), h('Jh Td 5h 4h 8d')).score), 5);
  // the returned five really are 2 from hand + 3 from board
  const hole = h('Ah Kh Qd 2c');
  const board = h('Jh Td 5h 4h 8d');
  const best = bestOmaha(hole, board);
  assert.equal(best.cards.filter((c) => hole.includes(c)).length, 2);
  assert.equal(best.cards.filter((c) => board.includes(c)).length, 3);
});

// ---------- deck limits ----------

test('crossword player limits match the spec table', () => {
  const table = [[2, true, 12], [2, false, 13], [4, true, 6], [4, false, 6], [5, true, 5], [5, false, 5]];
  for (const [hole, co, max] of table) {
    assert.equal(crosswordMaxPlayers(hole, co), max);
    for (const layout of ['crossword', 'slots']) {
      const rules = { ...DEFAULT_RULES, hole, carryover: co, layout, boards: 5 };
      const ok = planGame(rules, max);
      assert.ok(ok.ok && ok.rows === 5, `${layout} ${hole} ${co} at max`);
      const over = planGame(rules, max + 1);
      if (layout === 'crossword') {
        assert.equal(over.ok, false);
        assert.match(over.reason, new RegExp(`maxes out at ${max} players`));
      } else {
        assert.ok(over.ok && over.rows < 5 && over.notes.length > 0);
      }
    }
  }
});

test('slots drops boards one at a time and blocks when none fit', () => {
  const rules = { ...DEFAULT_RULES, hole: 5, carryover: false, layout: 'slots', boards: 5 };
  assert.deepEqual([5, 6, 7, 8, 9].map((n) => planGame(rules, n).rows), [5, 4, 3, 2, 1]);
  const blocked = planGame(rules, 10);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /no room/);
  assert.equal(planGame(rules, 1).ok, false);
});

test('burn is the first thing dropped', () => {
  const rules = { ...DEFAULT_RULES, hole: 2, carryover: true, layout: 'crossword' };
  const tight = planGame(rules, 12); // 25 + 24 leaves 3: the Pocket takes them all, no burn
  assert.equal(tight.pocket, 3);
  assert.equal(tight.burn, false);
  assert.equal(tight.cardsUsed, 52);
  const roomy = planGame(rules, 2); // plenty left: the Pocket gets 5 and there is a burn
  assert.equal(roomy.pocket, 5);
  assert.equal(roomy.burn, true);
  const r4 = { ...DEFAULT_RULES, hole: 4, carryover: false, layout: 'slots', boards: 5 };
  assert.equal(planGame(r4, 8).cardsUsed, 52); // 32 + 20 = 52, no burn
  assert.equal(planGame(r4, 8).burn, false);
  assert.equal(planGame(r4, 8).rows, 4);
});

// ---------- dealing ----------

test('every dealt card is unique and the reveal order is flop, turn, river', () => {
  const rules = { ...DEFAULT_RULES, hole: 4, carryover: true, layout: 'crossword' };
  const plan = planGame(rules, 5);
  const deck = makeDeck();
  const d = dealGame(rules, plan, ['a', 'b', 'c', 'd', 'e'], deck);
  const all = [...Object.values(d.hole).flat(), ...d.carryHole, d.burn, ...d.grid.flat()];
  assert.equal(d.carryHole.length, 5); // 52 - 25 - 20 leaves 7: the Pocket takes 5
  assert.equal(all.length, 51);
  assert.equal(new Set(all).size, 51);
  // with an unshuffled deck: 20 hole cards, 5 for the Pocket, 1 burn, then 15 flop, 5 turn, 5 river
  assert.deepEqual(d.grid[0].slice(0, 3), deck.slice(26, 29));
  assert.deepEqual(d.grid[1].slice(0, 3), deck.slice(29, 32));
  assert.deepEqual(d.grid.map((r) => r[3]), deck.slice(41, 46));
  assert.deepEqual(d.grid.map((r) => r[4]), deck.slice(46, 51));
  const boards = boardsOf(d.grid, 'crossword');
  assert.equal(boards.length, 10);
  assert.deepEqual(boards[5], d.grid.map((r) => r[0])); // 1 Down is column 1
  assert.equal(new Set(shuffle(deck, seeded(1))).size, 52);
});

// ---------- stakes, splits, carryover ----------

test('stake examples from the spec', () => {
  const slots = planGame({ ...DEFAULT_RULES, hole: 2, layout: 'slots', boards: 5, stakeCents: 200 }, 5);
  assert.deepEqual(slots.pots, [200, 200, 200, 200, 200]);
  const cw = planGame({ ...DEFAULT_RULES, hole: 2, layout: 'crossword', stakeCents: 200 }, 5);
  assert.equal(cw.perPlayer, 400);
  assert.deepEqual(cw.pots, Array(10).fill(200));
  // uneven: 3 players x $1 over 5 boards -> extra cents on the lowest boards
  assert.deepEqual(splitEven(301, 5), [61, 60, 60, 60, 60]);
  assert.deepEqual(splitEven(100, 3), [34, 33, 33]);
});

test('board pays the best hand, ties split, carryover share is kept apart', () => {
  const board = [h('Ks Kd 7c 4h 2s')];
  const hands = [
    { id: 'a', cards: h('Ah Kc') },
    { id: 'b', cards: h('Ad Kh') },
    { id: 'c', cards: h('Qh Qc') },
  ];
  const { results, deltas } = resolveBoards(board, [1001], hands, 'any');
  assert.equal(results[0].handName, 'Three Kings');
  assert.deepEqual(deltas, { a: 501, b: 500, c: 0 });
  // carryover hand ties with a: it is last in line for the odd cent
  const hands2 = [{ id: 'a', cards: h('Ah Kc') }, { id: 'c', cards: h('Qh Qc') }, { id: CARRY_ID, cards: h('Ad Kh') }];
  const r2 = resolveBoards(board, [1001], hands2, 'any');
  assert.deepEqual(r2.deltas, { a: 501, c: 0, [CARRY_ID]: 500 });
});

test('settle-up transfers clear every balance', () => {
  const bal = [
    { name: 'A', cents: 1250 }, { name: 'B', cents: -700 }, { name: 'C', cents: -900 },
    { name: 'D', cents: 350 }, { name: 'E', cents: 0 },
  ];
  const tx = settleUp(bal);
  const net = Object.fromEntries(bal.map((b) => [b.name, b.cents]));
  for (const t of tx) { net[t.from] += t.cents; net[t.to] -= t.cents; assert.ok(t.cents > 0); }
  assert.ok(Object.values(net).every((v) => v === 0));
  assert.ok(tx.length <= 3);
});

test('auto discard keeps the strong cards', () => {
  assert.equal(autoDiscard(h('As Ah Ks Kh 7d')), 4);
  // after the flop it keeps what makes a hand on the visible boards
  const idx = autoDiscard(h('2c 9h 9d Ac Kc'), [h('9s 9c 4d'), h('Qh Jd 3s')]);
  assert.equal(idx, 0);
});

// ---------- fast evaluator and 5-Card Any ----------

// slow, obviously-correct reference used to check the fast evaluator
function refEval(cards) {
  const vals = cards.map((c) => '23456789TJQKA'.indexOf(c[0]) + 2).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  let hi = 0;
  if (groups.length === 5) {
    if (vals[0] - vals[4] === 4) hi = vals[0];
    else if (vals[0] === 14 && vals[1] === 5) hi = 5;
  }
  let cat;
  let tb = [];
  if (hi) { cat = flush ? 8 : 4; tb = [hi, 0, 0, 0, 0]; } else {
    const shape = groups.map((g) => g[1]).join('');
    cat = { 41: 7, 32: 6, 311: 3, 221: 2, 2111: 1 }[shape] ?? (flush ? 5 : 0);
    for (const [v, n] of groups) for (let i = 0; i < n; i++) tb.push(v);
  }
  return tb.reduce((a, v) => a * 15 + v, cat);
}

test('fast evaluator agrees with the reference on 20,000 random hands', () => {
  const rnd = seeded(42);
  for (let i = 0; i < 20000; i++) {
    const five = shuffle(makeDeck(), rnd).slice(0, 5);
    assert.equal(evaluate5(five), refEval(five), five.join(' '));
  }
});

test('integer best-hand search agrees with the card version', () => {
  const rnd = seeded(5);
  for (let i = 0; i < 1500; i++) {
    const d = shuffle(makeDeck(), rnd);
    const board = d.slice(0, 5);
    for (const [n, mode] of [[2, 'any'], [4, 'exact'], [5, 'any'], [5, 'exact']]) {
      const hole = d.slice(5, 5 + n);
      assert.equal(bestScoreI(toInts(hole), toInts(board), mode), bestHand(hole, board, mode).score);
    }
  }
});

test('5-Card Any uses 0, 1 or 2 hole cards, never more', () => {
  // a royal flush entirely in hand is worth nothing: only two of those cards may play
  const r = bestHand(h('As Ks Qs Js Ts'), h('2c 3d 4h 7c 9d'), 'any');
  assert.equal(handCategory(r.score), 0);
  assert.equal(r.cards.filter((c) => h('As Ks Qs Js Ts').includes(c)).length, 2);
  // zero hole cards: the board plays
  assert.equal(handName(bestHand(h('2c 3d 4h 7c 9d'), h('As Ks Qs Js Ts'), 'any').score), 'Royal flush');
  // one hole card with four from the board
  const one = bestHand(h('Ah 2c 3d 7s 8s'), h('Kh Qh Jh Th 4c'), 'any');
  assert.equal(handName(one.score), 'Royal flush');
  assert.equal(one.cards.filter((c) => c === 'Ah').length, 1);
  // three hearts in hand + two on board is not a flush
  assert.notEqual(handCategory(bestHand(h('Ah Kh Qh 2c 3d'), h('9h 8h 4s 5c Jd'), 'any').score), 5);
});

// ---------- odds ----------

test('odds: exact on the turn, certain on the river, sensible before the flop', () => {
  const hands = [{ id: 'a', cards: h('Ah Ad') }, { id: 'b', cards: h('Kh Kd') }];
  const turn = h('2c 7d 9s Js');
  const gone = new Set([...h('Ah Ad Kh Kd'), ...turn]);
  const unseen = makeDeck().filter((c) => !gone.has(c));
  const [o] = computeOdds(hands, 'any', [turn], unseen);
  assert.ok(Math.abs(o.b - 2 / 44) < 1e-9); // kings need one of two kings from 44 cards
  assert.ok(Math.abs(o.a + o.b - 1) < 1e-9);
  const [done] = computeOdds(hands, 'any', [h('2c 7d 9s Js Kc')], unseen);
  assert.deepEqual(done, { a: 0, b: 1 });
  const pre = computeOdds(hands, 'any', [[], []], makeDeck().filter((c) => !h('Ah Ad Kh Kd').includes(c)), ((r) => () => r(1e9) / 1e9)(seeded(3)));
  assert.ok(pre[0].a > 0.76 && pre[0].a < 0.88, `aces vs kings: ${pre[0].a}`);
  assert.equal(pre[0], pre[1]); // identical unknown boards share one calculation
  // a split pot counts as half each
  const tie = computeOdds([{ id: 'a', cards: h('Ah 2d') }, { id: 'b', cards: h('Ad 2h') }], 'any', [h('Ks Kc 9s 9c 5d')], []);
  assert.deepEqual(tie, [{ a: 0.5, b: 0.5 }]);
});

test('outlook: current hand, what to look for, and the cards that get there', () => {
  // 9 T in hand, Q K on board: any jack makes the straight
  const hole = h('9h Tc');
  const board = h('Qd Ks 2c');
  const unseen = makeDeck().filter((c) => ![...hole, ...board].includes(c));
  const o = outlook(hole, board, unseen, 'any');
  assert.equal(o.name, 'King high');
  assert.equal(o.toCome, 2);
  const straight = o.rows.find((r) => r.label === 'Straight');
  assert.deepEqual(straight.cards.sort(), ['Jc', 'Jd', 'Jh', 'Js']);
  assert.ok(Math.abs(straight.next - 4 / 47) < 1e-9);
  assert.ok(straight.final > straight.next && straight.final < 0.2);
  const pair = o.rows.find((r) => r.label === 'Pair');
  assert.equal(pair.cards.length, 15); // three each of 9, T, Q, K, 2
  assert.ok(o.rows.find((r) => r.label === 'Two pair').cards.length === 0); // needs both cards
  assert.ok(o.rows[0].category > o.rows[o.rows.length - 1].category);
  // on the turn there is one card to come, and a finished board has nothing to look for
  const turn = outlook(hole, [...board, 'Jd'], unseen.filter((c) => c !== 'Jd'), 'any');
  assert.equal(turn.name, 'Straight, King high');
  assert.equal(turn.rows.every((r) => r.final === null), true);
  assert.equal(outlook(hole, h('Qd Ks 2c Jd 3s'), [], 'any').rows.length, 0);
  // Omaha rules apply: four spades on board with one spade in hand is no flush draw made
  const om = outlook(h('As Kd 7c 2h'), h('Qs 9s 4s'), makeDeck().filter((c) => !h('As Kd 7c 2h Qs 9s 4s').includes(c)), 'exact');
  assert.equal(om.rows.find((r) => r.label === 'Flush'), undefined);
});

test('long-term stats only count games between people', () => {
  const s = newSession('TEST', 'hostDev', 'Nick');
  addBot(s);
  deal(s, seeded(1));
  while (s.game.stage !== 'done') advance(s);
  assert.equal(s.log[0].online, false);
  const pat = claim(s, 'devA', { name: 'Pat' }).id;
  deal(s, seeded(2));
  while (s.game.stage !== 'done') advance(s);
  assert.equal(s.log[1].online, true);
  assert.equal(s.log[1].net.filter((n) => !n.bot).length, 2);
  setSitOut(s, pat, true);
  deal(s, seeded(3));
  while (s.game.stage !== 'done') advance(s);
  assert.equal(s.log[2].online, false); // Pat watched, so it was a CPU game again
});

// ---------- full sessions ----------

function playGame(s, rnd) {
  assert.deepEqual(deal(s, rnd), { ok: true });
  let guard = 0;
  while (s.game.stage !== 'done') {
    const r = advance(s);
    if (r.error) {
      for (const id of s.game.order) discard(s, id, 0); // humans throw away their first card
      autoDiscardRest(s);
    }
    assert.ok(guard++ < 50);
  }
}

const chipTotal = (s) => s.players.reduce((a, p) => a + p.balance, 0) + s.carry.reduce((a, b) => a + b, 0);
const join = (s, did, name) => claim(s, did, { name }).id;

test('the Pocket takes every leftover card, up to five, whatever the players hold', () => {
  // five players with five cards on a full crossword: 25 + 25 leaves exactly 2 for the Pocket
  const five = planGame({ ...DEFAULT_RULES, hole: 5, layout: 'crossword', carryover: true }, 5);
  assert.ok(five.ok);
  assert.equal(five.pocket, 2);
  assert.equal(five.cardsUsed, 52);
  assert.equal(five.burn, false);
  assert.match(five.notes.join(' '), /Pocket gets 2 cards/);
  assert.equal(planGame({ ...DEFAULT_RULES, hole: 5, layout: 'crossword', carryover: true }, 6).ok, false);
  // two Hold'em players leave lots of cards: the Pocket still gets five
  assert.equal(planGame({ ...DEFAULT_RULES, hole: 2, layout: 'crossword', carryover: true }, 2).pocket, 5);
  // slots keeps as many boards as it can and gives the Pocket the rest
  const slots = planGame({ ...DEFAULT_RULES, hole: 4, layout: 'slots', boards: 5, carryover: true }, 6);
  assert.equal(slots.rows, 5);
  assert.equal(slots.pocket, 3);
  // full Pineapple game with a 2-card Pocket: it never discards and plays both cards
  for (const free of [false, true]) {
    const s = newSession('TEST', 'hostDev', 'Host');
    for (let i = 0; i < 4; i++) addBot(s);
    setRules(s, { hole: 5, free, layout: 'crossword', carryover: true, discardTiming: 'post' });
    const rnd = seeded(free ? 11 : 12);
    for (let k = 0; k < 20; k++) {
      playGame(s, rnd);
      assert.equal(s.game.carryHole.length, 2);
      assert.equal(s.game.carryDiscard, undefined);
      assert.equal(chipTotal(s), 0);
      for (const r of s.game.results) for (const w of r.winners) {
        if (w.id !== CARRY_ID) continue;
        const used = w.cards.filter((c) => s.game.carryHole.includes(c)).length;
        if (free) assert.ok(used <= 2); else assert.equal(used, 2);
      }
    }
  }
  // a five-card Pocket in Hold'em plays at most two of its cards
  const s = newSession('TEST', 'hostDev', 'Host');
  addBot(s);
  setRules(s, { hole: 2, layout: 'crossword', carryover: true });
  const rnd = seeded(13);
  for (let k = 0; k < 20; k++) {
    playGame(s, rnd);
    assert.equal(s.game.carryHole.length, 5);
    for (const r of s.game.results) for (const w of r.winners) {
      if (w.id === CARRY_ID) assert.ok(w.cards.filter((c) => s.game.carryHole.includes(c)).length <= 2);
    }
  }
});


test('chips are conserved across every option combination', () => {
  let seed = 1;
  for (const [hole, free] of [[2, false], [4, false], [5, false], [5, true]]) {
    for (const layout of ['slots', 'crossword']) {
      for (const carryover of [true, false]) {
        for (const discardTiming of hole === 5 && !free ? ['pre', 'post'] : ['pre']) {
          const s = newSession('TEST', 'hostDev', 'Host');
          const n = Math.min(4, crosswordMaxPlayers(hole, carryover));
          for (let i = 1; i < n; i++) (i % 2 ? join(s, `dev${i}`, `P${i}`) : addBot(s));
          assert.deepEqual(setRules(s, { hole, free, layout, carryover, discardTiming, boards: 5, stakeCents: 137 }), { ok: true });
          setRules(s, { showOdds: false });
          assert.equal(s.rules.free, free);
          const rnd = seeded(seed++);
          for (let gme = 0; gme < 25; gme++) {
            playGame(s, rnd);
            assert.equal(chipTotal(s), 0, `${hole}/${free}/${layout}/${carryover}/${discardTiming} game ${gme}`);
            const g = s.game;
            const paid = g.results.reduce((a, r) => a + r.winners.reduce((x, w) => x + w.cents, 0), 0);
            assert.equal(paid, g.plan.pots.reduce((a, b) => a + b, 0));
            assert.equal(g.results.length, layout === 'crossword' ? 10 : 5);
            if (!carryover) assert.ok(!carryLocked(s));
            if (hole === 5 && !free) {
              for (const id of g.order) assert.ok(Number.isInteger(g.discard[id]));
              if (carryover) assert.equal(Number.isInteger(g.carryDiscard), g.carryHole.length === 5);
            } else {
              assert.deepEqual(g.discard, {});
            }
            for (const r of g.results) for (const w of r.winners) {
              const mine = w.id === CARRY_ID ? g.carryHole : g.hole[w.id];
              const used = w.cards.filter((c) => mine.includes(c)).length;
              if (hole === 2 || free) assert.ok(used <= 2); else assert.equal(used, 2);
            }
          }
          assert.equal(s.log.length, 25);
          assert.deepEqual(endSession(s), { ok: true });
          assert.equal(s.players.reduce((a, p) => a + p.balance, 0), 0);
          const net = Object.fromEntries(s.players.map((p) => [p.name, p.balance]));
          for (const t of s.settle) { net[t.from] += t.cents; net[t.to] -= t.cents; }
          assert.ok(Object.values(net).every((v) => v === 0));
        }
      }
    }
  }
});

test('a carried pot lands on the same board next game and locks the rules', () => {
  const rnd = seeded(99);
  let found = false;
  for (let attempt = 0; attempt < 200 && !found; attempt++) {
    const s = newSession('TEST', 'hostDev', 'Host');
    join(s, 'dev1', 'Pat');
    setRules(s, { hole: 2, layout: 'crossword', carryover: true, stakeCents: 500 });
    setRules(s, { showOdds: false });
    playGame(s, rnd);
    if (!carryLocked(s)) continue;
    found = true;
    const carried = s.carry.slice();
    for (const r of s.game.results) {
      const share = r.winners.filter((w) => w.id === CARRY_ID).reduce((a, w) => a + w.cents, 0);
      assert.equal(carried[r.index], share);
    }
    toLobby(s);
    assert.match(setRules(s, { layout: 'slots' }).error, /locked/);
    assert.match(setRules(s, { carryover: false }).error, /locked/);
    assert.equal(s.rules.layout, 'crossword');
    assert.deepEqual(setRules(s, { showOdds: true }), { ok: true }); // display setting is never locked
    setRules(s, { showOdds: false });
    playGame(s, rnd);
    s.game.plan.pots.forEach((pot, i) => assert.equal(pot, 200 + carried[i]));
    assert.equal(chipTotal(s), 0);
  }
  assert.ok(found, 'the Pocket never won in 200 games');
});

test('a carried slots pot blocks the deal when its board no longer fits', () => {
  const s = newSession('TEST', 'hostDev', 'Host');
  for (let i = 0; i < 3; i++) addBot(s);
  setRules(s, { hole: 5, layout: 'slots', carryover: true, boards: 5 });
  s.carry[4] = 300; // pretend the Pocket won board 5
  s.players[0].balance = -300;
  assert.equal(viewFor(s, 'p1').plan.ok, true);
  addBot(s); // 5 players: 5 boards still fit, the Pocket just gets fewer cards
  assert.equal(viewFor(s, 'p1').plan.ok, true);
  addBot(s); // 6 players x 5 cards + 2 for the Pocket: only 4 boards fit
  const v = viewFor(s, 'p1');
  assert.equal(v.plan.ok, false);
  assert.match(v.plan.reason, /Board 5/);
  assert.match(deal(s, seeded(1)).error, /Board 5/);
  removePlayer(s, s.players[5].id);
  assert.deepEqual(deal(s, seeded(1)), { ok: true });
  assert.equal(s.game.plan.pots[4], 200 + 300);
  assert.equal(s.game.carryHole.length, 2);
});

test('ending with a pending carryover refunds it', () => {
  const s = newSession('TEST', 'hostDev', 'Host');
  addBot(s);
  s.carry[2] = 301;
  s.players[0].balance = -200;
  s.players[1].balance = -101;
  endSession(s);
  assert.equal(s.refund.total, 301);
  assert.deepEqual(s.players.map((p) => p.balance), [-49, 49]);
  assert.deepEqual(s.settle, [{ from: 'Host', to: 'CPU 1', cents: 49 }]);
});

test('hole cards stay private until the showdown, even with odds showing', () => {
  const s = newSession('TEST', 'hostDev', 'Host');
  const pat = join(s, 'dev1', 'Pat');
  join(s, 'dev2', 'Sam');
  setRules(s, { hole: 5, layout: 'crossword', carryover: true, discardTiming: 'post' });
  deal(s, seeded(7));
  const g = s.game;
  for (const stage of ['pre', 'flop', 'turn', 'river']) {
    assert.equal(g.stage, stage);
    const visibleCols = { pre: 0, flop: 3, turn: 4, river: 5 }[stage];
    for (const id of [...g.order, null]) {
      const v = viewFor(s, id);
      const json = JSON.stringify(v);
      const hidden = [
        ...g.order.filter((o) => o !== id).flatMap((o) => g.hole[o]),
        ...g.carryHole,
        g.burn,
        ...g.grid.flatMap((row) => row.slice(visibleCols)),
      ];
      for (const c of hidden) assert.ok(!json.includes(`"${c}"`), `${id} can see ${c} at ${stage}`);
      if (id) for (const c of g.hole[id]) assert.ok(json.includes(`"${c}"`));
      // Pineapple: no odds until every discard is in
      if (stage === 'pre') { assert.equal(v.game.odds, null); assert.equal(v.game.oddsWait, true); }
      if (stage === 'turn') {
        assert.equal(v.game.odds.boards.length, 10);
        assert.equal(v.game.odds.boards[0].length, 4); // three players and the Pocket
        for (const b of v.game.odds.boards) assert.ok(Math.abs(b.reduce((a, x) => a + x.share, 0) - 1) < 1e-9);
        const ev = v.game.odds.ev.reduce((a, x) => a + x.cents, 0);
        assert.ok(Math.abs(ev - g.plan.total) <= 4);
        assert.ok(v.game.odds.ev.some((x) => x.name === 'The Pocket'));
      }
      if (stage === 'river') for (const b of v.game.odds.boards) for (const x of b) assert.ok([0, 0.5, 1].includes(x.share) || x.share === 1 / 3 || x.share === 0.25);
    }
    if (stage === 'flop') {
      assert.match(advance(s).error, /discards/);
      assert.equal(viewFor(s, pat).game.needDiscard, true);
      assert.equal(viewFor(s, pat).game.odds, null);
      for (const id of g.order) assert.deepEqual(discard(s, id, 2), { ok: true });
      assert.match(discard(s, pat, 1).error, /already/);
      assert.ok(viewFor(s, pat).game.odds);
    }
    advance(s);
  }
  assert.equal(g.stage, 'showdown');
  const v = viewFor(s, pat);
  assert.equal(v.game.hands.length, 4);
  assert.equal(v.game.hands[0].cards.length, 4);
  assert.equal(v.game.results.length, 1); // boards are paid one at a time
  assert.equal(v.game.results[0].all.length, 4); // every hand on that board, best first
  assert.equal(v.game.results[0].all[0].handName, v.game.results[0].handName);
  assert.equal(v.game.odds.boards[0], null);
  assert.equal(v.log.length, 0); // the running game is not in the history yet
  const shown = v.players.reduce((a, p) => a + p.balance, 0);
  const paidSoFar = v.game.results[0].winners.filter((w) => w.id !== CARRY_ID).reduce((a, w) => a + w.cents, 0);
  assert.equal(shown, paidSoFar - 3 * g.plan.perPlayer);
});

test('win % is the host\'s choice online and always on against CPUs', () => {
  const s = newSession('TEST', 'hostDev', 'Host');
  addBot(s);
  setRules(s, { showOdds: false });
  assert.equal(oddsOn(s), true); // only one human
  deal(s, seeded(2));
  assert.ok(viewFor(s, 'p1').game.odds);
  while (s.game.stage !== 'done') advance(s);
  toLobby(s);
  const pat = join(s, 'dev1', 'Pat');
  assert.equal(oddsOn(s), false);
  deal(s, seeded(3));
  assert.equal(viewFor(s, pat).game.odds, null);
  while (s.game.stage !== 'done') advance(s);
  toLobby(s);
  setRules(s, { showOdds: true });
  deal(s, seeded(4));
  assert.ok(viewFor(s, pat).game.odds);
});

test('phones check in as players, can switch, and never lose a seat', () => {
  const s = newSession('TEST', 'hostDev', 'Nick');
  const pat = join(s, 'devA', 'Pat');
  const sam = join(s, 'devB', 'Sam');
  assert.equal(viewFor(s, null).you, null);
  // a typo name that never played vanishes when the phone switches
  const typo = join(s, 'devC', 'Jmie');
  assert.deepEqual(unclaim(s, 'devC'), { ok: true });
  assert.ok(!s.players.some((p) => p.id === typo));
  const jamie = join(s, 'devC', 'Jamie');
  deal(s, seeded(8));
  while (s.game.stage !== 'done') advance(s);
  // Sam's phone dies; Sam checks in on a new phone and keeps the same seat and balance
  const before = s.players.find((p) => p.id === sam).balance;
  assert.equal(claim(s, 'devNew', { id: sam }).id, sam);
  assert.equal(s.devices.devB, undefined);
  assert.equal(s.players.find((p) => p.id === sam).balance, before);
  // picking the wrong existing player and switching back leaves that player untouched
  assert.equal(claim(s, 'devC', { id: pat }).id, pat);
  assert.equal(s.devices.devA, undefined);
  unclaim(s, 'devC');
  assert.ok(s.players.some((p) => p.id === pat) && s.players.some((p) => p.id === jamie));
  assert.equal(claim(s, 'devC', { name: 'jamie' }).id, jamie); // names match ignoring case
  assert.match(claim(s, 'devC', { name: 'Nick' }).error, /host/);
  assert.match(claim(s, 'hostDev', { name: 'Zed' }).error, /host/);
  assert.equal(s.players.filter((p) => !p.bot).length, 4);
});

test('sitting out spectates without leaving the ledger', () => {
  const s = newSession('TEST', 'hostDev', 'Host');
  const pat = join(s, 'devA', 'Pat');
  addBot(s);
  deal(s, seeded(3));
  const late = join(s, 'devB', 'Late');
  assert.equal(viewFor(s, late).game.myHole, null); // joined mid-game: watches until the next deal
  assert.match(removePlayer(s, s.players[2].id).error, /finishes/);
  while (s.game.stage !== 'done') advance(s);
  const bal = s.players.find((p) => p.id === pat).balance;
  setSitOut(s, pat, true);
  deal(s, seeded(4));
  assert.deepEqual(s.game.order.includes(pat), false);
  assert.equal(s.game.order.length, 3);
  assert.equal(viewFor(s, pat).game.myHole, null);
  while (s.game.stage !== 'done') advance(s);
  assert.equal(s.players.find((p) => p.id === pat).balance, bal);
  setSitOut(s, pat, false);
  deal(s, seeded(5));
  assert.ok(s.game.order.includes(pat));
});

test('the host can be passed to another phone and the state survives a copy', () => {
  const s = newSession('TEST', 'hostDev', 'Host');
  const pat = join(s, 'devA', 'Pat');
  addBot(s);
  assert.match(passHost(s, s.players[2].id).error, /phone/);
  deal(s, seeded(6));
  advance(s);
  assert.deepEqual(passHost(s, pat), { ok: true });
  const moved = JSON.parse(JSON.stringify(s)); // what the new host's phone receives
  assert.equal(moved.hostDid, 'devA');
  assert.equal(viewFor(moved, pat).hostId, pat);
  while (moved.game.stage !== 'done') advance(moved);
  assert.equal(chipTotal(moved), 0);
  assert.match(removePlayer(moved, pat).error, /host/);
  assert.deepEqual(removePlayer(moved, 'p1'), { ok: true }); // the old host is now an ordinary player
});

test('one board at a time: each tap reveals one board, in deal order', () => {
  const s = newSession('TEST', 'hostDev', 'Host');
  addBot(s);
  setRules(s, { hole: 2, layout: 'slots', boards: 3 });
  setOption(s, { stepReveal: true });
  deal(s, seeded(21));
  const up = () => viewFor(s, 'p1').game.grid.map((row) => row.filter(Boolean).length);
  assert.deepEqual(up(), [0, 0, 0]);
  assert.deepEqual(viewFor(s, 'p1').game.next, { street: 'flop', board: 0, started: false });
  advance(s); assert.deepEqual(up(), [3, 0, 0]);
  assert.equal(s.game.stage, 'pre'); // the flop is not finished yet
  assert.deepEqual(viewFor(s, 'p1').game.next, { street: 'flop', board: 1, started: true });
  // odds follow the cards actually showing
  const odds = viewFor(s, 'p1').game.odds.boards;
  assert.ok(Math.abs(odds[1][0].share + odds[1][1].share - 1) < 1e-9);
  advance(s); advance(s); assert.deepEqual(up(), [3, 3, 3]);
  assert.equal(s.game.stage, 'flop');
  advance(s); assert.deepEqual(up(), [4, 3, 3]);
  // switching back mid-street finishes the street in one tap
  setOption(s, { stepReveal: false });
  advance(s); assert.deepEqual(up(), [4, 4, 4]);
  assert.equal(s.game.stage, 'turn');
  advance(s); assert.deepEqual(up(), [5, 5, 5]);
  advance(s); assert.equal(s.game.stage, 'showdown');
  // the showdown never moves by itself: one tap per board
  assert.equal(s.game.payIndex, 1);
  advance(s); assert.equal(s.game.payIndex, 2);
  advance(s); advance(s);
  assert.equal(s.game.stage, 'done');
  assert.equal(chipTotal(s), 0);
});

test('one board at a time works with Pineapple discards after the flop', () => {
  const s = newSession('TEST', 'hostDev', 'Host');
  const pat = join(s, 'devA', 'Pat');
  setRules(s, { hole: 5, layout: 'crossword', carryover: true, discardTiming: 'post' });
  setOption(s, { stepReveal: true });
  deal(s, seeded(22));
  for (let k = 0; k < 5; k++) { assert.equal(viewFor(s, pat).game.needDiscard, false); advance(s); }
  assert.equal(s.game.stage, 'flop');
  assert.equal(viewFor(s, pat).game.needDiscard, true);
  assert.match(advance(s).error, /discards/);
  discard(s, 'p1', 0); discard(s, pat, 4);
  let guard = 0;
  while (s.game.stage !== 'done') { assert.deepEqual(advance(s), { ok: true }); assert.ok(guard++ < 40); }
  assert.equal(chipTotal(s), 0);
});

test('the deal can pass around the table, and the dealer runs the round', () => {
  const s = newSession('TEST', 'hostDev', 'Nick');
  const pat = join(s, 'devA', 'Pat');
  addBot(s);
  const sam = join(s, 'devB', 'Sam');
  assert.equal(controller(s), 'p1');
  assert.equal(canControl(s, pat), false);
  setOption(s, { dealerRotate: true });
  assert.equal(controller(s), 'p1');
  const run = () => { deal(s, seeded(30 + s.gameNo)); while (s.game.stage !== 'done') advance(s); };
  run();
  assert.equal(controller(s), pat); // passes to the next person
  assert.equal(canControl(s, pat), true);
  assert.equal(canControl(s, 'p1'), true); // the host can always step in
  assert.equal(canControl(s, sam), false);
  assert.equal(viewFor(s, sam).control, pat);
  run();
  assert.equal(controller(s), sam); // CPU players never deal
  setSitOut(s, 'p1', true);
  run();
  assert.equal(controller(s), pat); // people sitting out are skipped
  removePlayer(s, pat);
  assert.equal(controller(s), sam);
  setOption(s, { dealerRotate: false });
  assert.equal(controller(s), 'p1');
});

test('results carry the before-the-flop chance, and luck adds up', () => {
  const s = newSession('TEST', 'hostDev', 'Nick');
  const pat = join(s, 'devA', 'Pat');
  setRules(s, { hole: 4, layout: 'slots', boards: 5, carryover: true, stakeCents: 500 });
  setRules(s, { showOdds: false });
  const rnd = seeded(40);
  for (let k = 0; k < 6; k++) {
    deal(s, rnd);
    while (s.game.stage !== 'done') advance(s);
    const g = s.game;
    const pre = Object.values(g.pre).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(pre - 1) < 1e-9); // the two players and the Pocket share 100%
    const v = viewFor(s, pat);
    for (const r of v.game.results) for (const w of r.winners) assert.ok(w.pre > 0 && w.pre < 1);
    const st = s.log[k].stats;
    assert.equal(st.length, 2);
    // expected + luck is exactly what each player won
    const won = (id) => g.results.reduce((a, r) => a + r.winners.filter((w) => w.id === id).reduce((x, w) => x + w.cents, 0), 0);
    assert.equal(st[0].exp + st[0].luck, won('p1'));
    assert.equal(st[1].exp + st[1].luck, won(pat));
    assert.equal(v.game.net[0].luck, st[0].luck);
    assert.ok(s.log[k].best.handName.length > 0);
  }
  endSession(s);
  const titles = s.awards.map((a) => a.title);
  assert.ok(titles.includes('Best hand') && titles.includes('Most boards won') && titles.includes('Biggest board'));
  const luck = new Map();
  for (const l of s.log) for (const x of l.stats) luck.set(x.name, (luck.get(x.name) || 0) + x.luck);
  const unlucky = s.awards.find((a) => a.title === 'Unluckiest');
  if (unlucky) assert.equal(luck.get(unlucky.name), Math.min(...luck.values()));
  assert.deepEqual(computeAwards([]), []);
});
