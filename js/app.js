// Crossword Slots — phone UI and real-time sync.
// The host's phone runs the game (session.js) and sends every other phone only what
// that player is allowed to see. Phones talk directly to each other through PeerJS.

import * as S from './session.js';
import { cryptoRnd, money, HOLE_NAMES, CARRY_ID } from './engine.js';

const PEER_PREFIX = 'xwslots-v1-';
const PAY_MS = 3200;
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

const randomId = (n, alphabet) => Array.from({ length: n }, () => alphabet[cryptoRnd(alphabet.length)]).join('');
const newCode = () => randomId(4, 'ABCDEFGHJKLMNPQRSTUVWXYZ');

let pid = ls.get('xw_pid');
if (!pid) { pid = randomId(12, 'abcdefghijklmnopqrstuvwxyz0123456789'); ls.set('xw_pid', pid); }
let myName = ls.get('xw_name') || '';
const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

let role = null;      // 'host' | 'client'
let session = null;   // host only: the real game state
let view = null;      // what this phone may see
let roomCode = '';
let peer = null;
let hostConn = null;  // client only
const conns = new Map(); // host only: pid -> { conn, last }
let net = { status: 'idle', msg: '' };
let kicked = false;
let lastMsg = 0;
let retryTimer = null;
let autoTimer = null;
const ui = { sel: null, seenGame: 0, seen: new Set() };

// ---------- helpers ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SUIT = { c: '♣', d: '♦', h: '♥', s: '♠' };

function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { $toast.hidden = true; }, 2600);
}

function cardHtml(c, cls = '', attrs = '') {
  const red = c[1] === 'd' || c[1] === 'h';
  const rank = c[0] === 'T' ? '10' : c[0];
  return `<div class="card ${red ? 'red' : ''} ${cls}" ${attrs}><span class="r">${rank}</span><span class="s">${SUIT[c[1]]}</span></div>`;
}
const mini = (cards) => `<span class="mini">${cards.map((c) => cardHtml(c)).join('')}</span>`;
const balHtml = (c) => `<span class="bal ${c > 0 ? 'pos' : c < 0 ? 'neg' : ''}">${c > 0 ? '+' : ''}${money(c)}</span>`;
const joinUrl = () => `${location.origin}${location.pathname}?room=${roomCode}`;
const peerOpts = () => ({ debug: 0 });
const hasPeer = () => typeof window.Peer === 'function';

function rulesLine(r, rows) {
  const parts = [HOLE_NAMES[r.hole]];
  if (r.hole === 5) parts.push(r.discardTiming === 'pre' ? 'discard before flop' : 'discard after flop');
  parts.push(r.layout === 'crossword' ? 'Crossword' : `Slots × ${rows ?? r.boards}`);
  if (r.carryover) parts.push('Carryover');
  return parts.join(' · ');
}

// ---------- host ----------

function saveSession() { ls.set('xw_host', JSON.stringify(session)); }

function commit() {
  saveSession();
  broadcast();
  clearTimeout(autoTimer);
  if (session.phase === 'play' && session.game.stage === 'showdown') {
    autoTimer = setTimeout(() => { S.advance(session); commit(); }, PAY_MS);
  }
}

function broadcast() {
  const online = new Set([session.hostId, ...conns.keys()]);
  for (const [cpid, c] of conns) {
    if (c.conn.open) {
      try { c.conn.send({ t: 'state', view: S.viewFor(session, cpid, online) }); } catch { /* dropped */ }
    }
  }
  view = S.viewFor(session, pid, online);
  render();
}

function hostAct(result) {
  if (result && result.error) toast(result.error);
  commit();
}

function startHost(fresh) {
  role = 'host';
  roomCode = session.code;
  history.replaceState(null, '', `?room=${roomCode}`);
  saveSession();
  broadcast();
  openHostPeer(fresh);
}

function openHostPeer(fresh) {
  if (!hasPeer()) { net = { status: 'offline', msg: "Couldn't load the connection library, so friends can't join right now. You can still play against CPU players." }; render(); return; }
  if (peer) { try { peer.destroy(); } catch { /* gone */ } }
  net = { status: 'connecting', msg: '' };
  const p = new window.Peer(PEER_PREFIX + session.code, peerOpts());
  peer = p;
  p.on('open', () => { if (peer === p) { net = { status: 'online', msg: '' }; render(); } });
  p.on('connection', (conn) => {
    let cpid = null;
    conn.on('data', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'join') {
        cpid = String(m.pid || '').slice(0, 40);
        if (!cpid || cpid === session.hostId) { cpid = null; return; }
        const old = conns.get(cpid);
        if (old && old.conn !== conn) { try { old.conn.close(); } catch { /* gone */ } }
        conns.set(cpid, { conn, last: Date.now() });
        S.addPlayer(session, cpid, m.name);
        commit();
        return;
      }
      if (!cpid || !conns.has(cpid) || conns.get(cpid).conn !== conn) return;
      conns.get(cpid).last = Date.now();
      if (m.t === 'discard') { S.discard(session, cpid, m.idx); commit(); }
      else if (m.t === 'leave') { S.removePlayer(session, cpid); conns.delete(cpid); commit(); }
    });
    conn.on('close', () => {
      if (cpid && conns.get(cpid) && conns.get(cpid).conn === conn) { conns.delete(cpid); broadcast(); }
    });
  });
  p.on('disconnected', () => {
    if (peer !== p) return;
    net = { status: 'connecting', msg: 'Reconnecting…' };
    render();
    setTimeout(() => { if (peer === p && !p.destroyed) { try { p.reconnect(); } catch { openHostPeer(false); } } }, 1500);
  });
  p.on('error', (e) => {
    if (peer !== p) return;
    if (e.type === 'unavailable-id') {
      if (fresh && session.gameNo === 0 && session.players.length === 1) {
        session.code = newCode(); // someone else has this code: pick another
        startHost(true);
      } else {
        net = { status: 'connecting', msg: 'Reopening the room…' };
        render();
        setTimeout(() => { if (peer === p) openHostPeer(false); }, 3000);
      }
    } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(e.type)) {
      net = { status: 'connecting', msg: 'No connection. Friends will reconnect when you are back online.' };
      render();
      setTimeout(() => { if (peer === p) openHostPeer(false); }, 4000);
    }
  });
}

function hostHeartbeat() {
  if (role !== 'host') return;
  let changed = false;
  for (const [cpid, c] of conns) {
    if (Date.now() - c.last > 16000) { try { c.conn.close(); } catch { /* gone */ } conns.delete(cpid); changed = true; continue; }
    if (c.conn.open) { try { c.conn.send({ t: 'ping' }); } catch { /* dropped */ } }
  }
  if (changed) broadcast();
}

// ---------- client ----------

function startClient(code) {
  role = 'client';
  roomCode = code;
  kicked = false;
  ls.set('xw_room', code);
  history.replaceState(null, '', `?room=${code}`);
  connectClient();
}

function retryClient(msg) {
  if (role !== 'client' || kicked) return;
  net = { status: 'connecting', msg: msg || 'Reconnecting to the host…' };
  render();
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connectClient, 2500);
}

function connectClient() {
  clearTimeout(retryTimer);
  if (!hasPeer()) { net = { status: 'offline', msg: "Couldn't load the connection library. Check your internet and reload." }; render(); return; }
  if (peer) { try { peer.destroy(); } catch { /* gone */ } }
  if (net.status !== 'connecting') net = { status: 'connecting', msg: '' };
  render();
  const p = new window.Peer(peerOpts());
  peer = p;
  p.on('open', () => {
    if (peer !== p) return;
    const c = p.connect(PEER_PREFIX + roomCode, { reliable: true, serialization: 'json' });
    hostConn = c;
    c.on('open', () => { lastMsg = Date.now(); c.send({ t: 'join', pid, name: myName }); });
    c.on('data', (m) => {
      if (peer !== p || !m) return;
      lastMsg = Date.now();
      if (m.t === 'state') { view = m.view; net = { status: 'online', msg: '' }; render(); }
      else if (m.t === 'ping') { try { c.send({ t: 'pong' }); } catch { /* dropped */ } }
      else if (m.t === 'kicked') { kicked = true; view = null; ls.del('xw_room'); try { p.destroy(); } catch { /* gone */ } render(); }
    });
    c.on('close', () => { if (peer === p) retryClient(); });
    c.on('error', () => { if (peer === p) retryClient(); });
  });
  p.on('error', (e) => {
    if (peer !== p) return;
    retryClient(e.type === 'peer-unavailable'
      ? `Can't reach room ${roomCode}. Check the code, and make sure the host has the game open on their phone. Trying again…`
      : 'Connection problem. Trying again…');
  });
  p.on('disconnected', () => { if (peer === p && !(hostConn && hostConn.open)) retryClient(); });
}

function clientHeartbeat() {
  if (role !== 'client' || kicked || net.status !== 'online') return;
  if (Date.now() - lastMsg > 13000) retryClient();
}

setInterval(() => { hostHeartbeat(); clientHeartbeat(); }, 4000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (role === 'host' && peer && (peer.disconnected || peer.destroyed)) openHostPeer(false);
  if (role === 'client' && !kicked && Date.now() - lastMsg > 8000) connectClient();
});

// ---------- actions ----------

function readName() {
  const el = document.getElementById('name');
  const v = (el ? el.value : myName).trim().slice(0, 16);
  if (!v) { toast('Type your name first.'); if (el) el.focus(); return null; }
  myName = v;
  ls.set('xw_name', v);
  return v;
}

async function share() {
  const url = joinUrl();
  try {
    if (navigator.share) { await navigator.share({ title: 'Crossword Slots', text: `Join my Crossword Slots room ${roomCode}`, url }); return; }
  } catch { return; }
  try { await navigator.clipboard.writeText(url); toast('Join link copied.'); }
  catch { window.prompt('Copy this join link:', url); }
}

const actions = {
  create() {
    if (!readName()) return;
    session = S.newSession(newCode(), pid, myName);
    startHost(true);
  },
  resume() {
    session = JSON.parse(ls.get('xw_host'));
    startHost(false);
  },
  join() {
    if (!readName()) return;
    const el = document.getElementById('code');
    const code = (urlRoom || (el ? el.value : '')).toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) { toast('Enter the 4-letter room code.'); return; }
    startClient(code);
  },
  home() { location.href = location.pathname; },
  share,
  // host only
  rule(key, val) {
    const v = key === 'layout' || key === 'discardTiming' ? val : key === 'carryover' ? val === '1' : Number(val);
    hostAct(S.setRules(session, { [key]: v }));
  },
  addBot() { hostAct(S.addBot(session)); },
  kick(id) {
    const r = S.removePlayer(session, id);
    const c = conns.get(id);
    if (!r.error && c) { try { c.conn.send({ t: 'kicked' }); } catch { /* gone */ } conns.delete(id); }
    hostAct(r);
  },
  deal() { ui.sel = null; hostAct(S.deal(session, cryptoRnd)); },
  next() { hostAct(S.advance(session)); },
  autoDiscard() { hostAct(S.autoDiscardRest(session)); },
  lobby() { hostAct(S.toLobby(session)); },
  end() {
    if (!window.confirm('End the session and show the settle-up?')) return;
    hostAct(S.endSession(session));
  },
  fresh() { ls.del('xw_host'); location.href = location.pathname; },
  // everyone
  pick(i) { ui.sel = ui.sel === Number(i) ? null : Number(i); render(); },
  discard() {
    if (ui.sel === null) return;
    const idx = ui.sel;
    ui.sel = null;
    if (role === 'host') hostAct(S.discard(session, pid, idx));
    else if (hostConn && hostConn.open) hostConn.send({ t: 'discard', idx });
    else toast('Not connected. Try again in a moment.');
  },
  leave() {
    if (!window.confirm('Leave this room?')) return;
    if (hostConn && hostConn.open) { try { hostConn.send({ t: 'leave' }); } catch { /* gone */ } }
    ls.del('xw_room');
    setTimeout(() => { location.href = location.pathname; }, 150);
  },
};

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el.dataset.a, el.dataset.b);
});
$app.addEventListener('change', (e) => {
  if (e.target.id === 'stake' && role === 'host') {
    const v = Math.round(parseFloat(e.target.value) * 100);
    if (Number.isFinite(v) && v >= 1) hostAct(S.setRules(session, { stakeCents: v }));
    else { toast('Enter a stake above $0.'); render(); }
  }
});
$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'code' || (e.target.id === 'name' && urlRoom)) actions.join();
  else if (e.target.id === 'stake') e.target.blur();
});

// ---------- rendering ----------

function render() {
  if (!view) { $app.innerHTML = renderHome(); return; }
  const isHost = view.hostId === view.you;
  let body;
  if (view.phase === 'ended') body = renderEnded(isHost);
  else if (view.phase === 'lobby' || !view.game) body = renderLobby(isHost);
  else body = renderTable(isHost);
  $app.innerHTML = renderHeader() + body;
}

function renderHeader() {
  const dot = net.status === 'online' ? 'on' : net.status === 'connecting' ? 'wait' : '';
  return `<header>
    <div class="brand">Crossword <span>Slots</span></div>
    <button class="chip" data-act="share">Room <b>${esc(view.code)}</b> · Invite</button>
    <span class="dot ${dot}"></span>
  </header>${net.msg ? `<div class="netmsg">${esc(net.msg)}</div>` : ''}`;
}

function renderHome() {
  if (role === 'client') {
    if (kicked) {
      return `<div class="hero"><h1>Crossword <span>Slots</span></h1></div>
        <div class="panel center"><p>The host removed you from the room.</p><button class="btn" data-act="home">Back to start</button></div>`;
    }
    return `<div class="hero"><h1>Crossword <span>Slots</span></h1></div>
      <div class="panel center"><p><span class="dot wait" style="display:inline-block"></span> Joining room <b>${esc(roomCode)}</b>…</p>
      <p class="muted">${esc(net.msg || 'Connecting to the host’s phone.')}</p>
      <button class="btn ghost" data-act="home">Cancel</button></div>`;
  }
  let saved = null;
  try { saved = JSON.parse(ls.get('xw_host')); } catch { /* none */ }
  const resumable = saved && saved.phase !== 'ended';
  const nameField = `<label class="field" for="name">Your name</label>
    <input class="text" id="name" maxlength="16" autocomplete="off" placeholder="Name" value="${esc(myName)}">`;
  const hero = `<div class="hero"><div class="suits">♠<i>♥</i>♣<i>♦</i></div><h1>Crossword <span>Slots</span></h1>
    <p>Quintuple Pineapple Omaha Crossword 2-Card Carryover Slots Poker</p></div>`;
  if (urlRoom) {
    return `${hero}<div class="panel">${nameField}
      <button class="btn mt" data-act="join">Join room ${esc(urlRoom)}</button></div>
      <button class="btn ghost" data-act="home">Start my own room instead</button>`;
  }
  return `${hero}
    ${resumable ? `<div class="panel"><button class="btn" data-act="resume">Resume your room ${esc(saved.code)}</button></div>` : ''}
    <div class="panel">${nameField}
      <button class="btn mt" data-act="create">Create a room</button>
      <div class="or">or join a friend</div>
      <div class="row"><input class="text code grow" id="code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="CODE">
      <button class="btn sm" data-act="join" style="padding:13px 18px">Join</button></div>
    </div>
    <p class="muted center">Play money only. Create a room and add CPU players to try it solo.</p>`;
}

function seg(key, cur, options, disabled) {
  return `<div class="seg">${options.map(([val, label, sub]) => `<button data-act="rule" data-a="${key}" data-b="${val}" class="${String(cur) === String(val) ? 'on' : ''}" ${disabled ? 'disabled' : ''}>${label}${sub ? `<small>${sub}</small>` : ''}</button>`).join('')}</div>`;
}

function renderPlan() {
  const p = view.plan;
  const r = view.rules;
  if (!p.ok) return `<div class="plan no"><p><b>Can't deal yet.</b> ${esc(p.reason)}</p></div>`;
  const carried = view.carry.reduce((a, b) => a + b, 0);
  const each = p.base[0] === p.base[p.base.length - 1] ? money(p.base[0]) : `${money(p.base[p.base.length - 1])}–${money(p.base[0])}`;
  return `<div class="plan ok">
    <p><b>Ready.</b> Each player puts in ${money(p.perPlayer)}${r.layout === 'crossword' ? ' (double stake)' : ''}: ${money(p.total)} total, ${each} on each of ${p.nBoards} board${p.nBoards === 1 ? '' : 's'}.</p>
    ${carried ? `<p class="co">Plus ${money(carried)} carried over: ${view.carry.map((c, i) => (c ? `${money(c)} on ${labelFor(r.layout, i)}` : '')).filter(Boolean).join(', ')}.</p>` : ''}
    ${p.notes.map((n) => `<p>${esc(n)}</p>`).join('')}
  </div>`;
}
const labelFor = (layout, i) => (layout === 'crossword' ? (i < 5 ? `${i + 1} Across` : `${i - 4} Down`) : `Board ${i + 1}`);

function renderPlayers(isHost, canKick) {
  return `<ul class="plist">${view.players.map((p) => `<li class="${p.active && p.online ? '' : 'off'}">
      <span class="nm">${esc(p.name)}${p.id === view.you ? '<span class="tag gold">You</span>' : ''}${p.id === view.hostId ? '<span class="tag">Host</span>' : ''}${p.bot ? '<span class="tag">CPU</span>' : ''}${!p.active ? '<span class="tag">Left</span>' : !p.online ? '<span class="tag">Offline</span>' : ''}${p.active && view.game && view.phase === 'play' && !p.inGame ? '<span class="tag">Next game</span>' : ''}${p.waiting ? '<span class="tag gold">Discarding</span>' : ''}</span>
      ${balHtml(p.balance)}
      ${isHost && canKick && p.active && p.id !== view.hostId ? `<button class="x" data-act="kick" data-a="${esc(p.id)}" aria-label="Remove">✕</button>` : ''}
    </li>`).join('')}</ul>`;
}

function renderLobby(isHost) {
  const r = view.rules;
  const lock = view.locked;
  const dis = !isHost || lock;
  const nActive = view.players.filter((p) => p.active).length;
  const rules = isHost
    ? `${lock ? '<div class="lock">🔒 Rules are locked until the carryover pot has been played out.</div>' : ''}
      <div class="opt"><div class="lab"><span>Hole cards</span></div>${seg('hole', r.hole, [[2, '2', "Hold'em"], [4, '4', 'Omaha'], [5, '5', 'Pineapple']], dis)}</div>
      ${r.hole === 5 ? `<div class="opt"><div class="lab"><span>Discard one card</span></div>${seg('discardTiming', r.discardTiming, [['pre', 'Before the flop'], ['post', 'After the flop']], dis)}</div>` : ''}
      <div class="opt"><div class="lab"><span>Board layout</span></div>${seg('layout', r.layout, [['slots', 'Slots', 'rows only'], ['crossword', 'Crossword', '5 across + 5 down']], dis)}</div>
      ${r.layout === 'slots' ? `<div class="opt"><div class="lab"><span>Boards</span></div>${seg('boards', r.boards, [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']], dis)}</div>` : ''}
      <div class="opt"><div class="lab"><span>Carryover hand</span></div>${seg('carryover', r.carryover ? 1 : 0, [[0, 'Off'], [1, 'On']], dis)}</div>
      <div class="opt row"><div class="grow">Base stake per player</div><div class="stake">$<input class="text" id="stake" type="number" inputmode="decimal" min="0.01" step="0.01" value="${(r.stakeCents / 100).toFixed(2)}" ${dis ? 'disabled' : ''}></div></div>`
    : `<p style="margin:0 0 8px"><b>${esc(rulesLine(r))}</b><br><span class="muted">Base stake ${money(r.stakeCents)} per player</span></p>`;
  return `
    <div class="panel"><h2>Players (${nActive})</h2>${renderPlayers(isHost, true)}
      ${isHost ? `<div class="row mt"><button class="btn ghost sm grow" data-act="addBot">+ Add CPU player</button><button class="btn ghost sm grow" data-act="share">Invite friends</button></div>` : ''}
    </div>
    <div class="panel"><h2>Rules for the next game</h2>${rules}${renderPlan()}
      <p class="muted small" style="margin:8px 0 0">Rounding: everything is counted in cents. If a pot doesn't split evenly, the extra cents go to the lowest-numbered boards, and on a tied board to the tied players in seat order (Carryover hand last).</p>
    </div>
    ${isHost ? '' : '<p class="status">Waiting for the host to deal…</p><button class="btn ghost" data-act="leave">Leave room</button>'}
    ${isHost ? `<div class="bar"><div class="in">
      <button class="btn" data-act="deal" ${view.plan.ok ? '' : 'disabled'}>Deal${view.game ? ' next game' : ''}</button>
      <button class="btn danger sm" style="width:100%" data-act="end">End session and settle up</button>
    </div></div>` : ''}`;
}

function renderGrid(g) {
  const cw = g.rules.layout === 'crossword';
  if (ui.seenGame !== g.no) { ui.seenGame = g.no; ui.seen = new Set(); }
  const paying = g.stage === 'showdown' && g.results && g.results.length ? g.results[g.results.length - 1] : null;
  const lit = paying ? paying.index : -1;
  const winCards = new Set(paying ? paying.winners.flatMap((w) => w.cards) : []);
  const inLit = (r, c) => (lit < 0 ? false : lit < g.rows && !(cw && lit >= 5) ? r === lit : c === lit - 5);
  // order new cards the way they are dealt: flop row by row, then turn, then river
  const fresh = [];
  for (const cols of [[0, 1, 2], [3], [4]]) {
    for (let r = 0; r < g.rows; r++) for (const c of cols) if (g.grid[r][c] && !ui.seen.has(g.grid[r][c])) fresh.push(g.grid[r][c]);
  }
  const potLab = (i) => `<span class="pot">${money(g.pots[i])}</span>`;
  let html = '<div class="grid">';
  if (cw) {
    html += '<div></div>';
    for (let c = 0; c < 5; c++) html += `<div class="glab top ${g.carryIn[5 + c] ? 'carry' : ''} ${lit === 5 + c ? 'lit' : ''}"><b>${c + 1}↓</b>${potLab(5 + c)}</div>`;
  }
  for (let r = 0; r < g.rows; r++) {
    html += `<div class="glab ${g.carryIn[r] ? 'carry' : ''} ${lit === r ? 'lit' : ''}"><b>${r + 1}${cw ? '→' : ''}</b>${potLab(r)}</div>`;
    for (let c = 0; c < 5; c++) {
      const card = g.grid[r][c];
      if (!card) { html += '<div class="slot"></div>'; continue; }
      const k = fresh.indexOf(card);
      let cls = k >= 0 ? 'deal' : '';
      if (paying) cls += inLit(r, c) ? (winCards.has(card) ? ' win' : '') : ' dim';
      html += cardHtml(card, cls, k >= 0 ? `style="animation-delay:${k * 70}ms"` : '');
    }
  }
  html += '</div>';
  for (const c of fresh) ui.seen.add(c);
  return html;
}

function winnersText(res) {
  const real = res.winners.filter((w) => w.id !== CARRY_ID);
  const carry = res.winners.find((w) => w.id === CARRY_ID);
  if (carry && !real.length) return `Carryover hand wins. <span class="co">${money(carry.cents)} carries to ${esc(res.label)} next game.</span>`;
  const names = real.map((w) => `${esc(w.name)} ${real.length > 1 || carry ? money(w.cents) : ''}`.trim()).join(', ');
  if (carry) return `Split: ${names}. <span class="co">${money(carry.cents)} carries over.</span>`;
  return real.length > 1 ? `Split: ${names}` : `${names} wins ${money(real[0].cents)}`;
}

function renderMyHand(g) {
  if (!g.myHole) return '<p class="status">You joined mid-game. You\'ll be dealt in next game.</p>';
  const shown = g.stage === 'showdown' || g.stage === 'done';
  if (shown) return '';
  const cards = g.myHole.map((c, i) => {
    if (g.needDiscard) return cardHtml(c, `tap ${ui.sel === i ? 'sel' : ''}`, `data-act="pick" data-a="${i}"`);
    return cardHtml(c, g.myDiscard === i ? 'gone' : '');
  }).join('');
  let extra = '';
  if (g.needDiscard) {
    extra = `<p class="status" style="margin-bottom:6px">Tap the card you want to throw away.</p>
      <button class="btn" data-act="discard" ${ui.sel === null ? 'disabled' : ''}>Discard${ui.sel === null ? '' : ' this card'}</button>`;
  }
  return `<div class="handlab">Your cards${g.rules.hole === 2 ? '' : ' · must play exactly 2'}</div><div class="hand">${cards}</div>${extra}`;
}

function renderTable(isHost) {
  const g = view.game;
  const paying = g.stage === 'showdown' ? g.results[g.results.length - 1] : null;
  const waiting = g.waitingOn.length;
  let mid = '';
  if (paying) {
    mid = `<div class="banner"><div class="t">${esc(paying.label)} · ${money(paying.pot)} pot</div>
      <div class="w">${winnersText(paying)}</div>
      <div class="h">${esc(paying.handName)} ${mini(paying.winners[0].cards)}</div></div>`;
  } else if (g.stage !== 'done') {
    const next = { pre: 'the flop', flop: 'the turn', turn: 'the river', river: 'the showdown' }[g.stage];
    mid = `<p class="status">${waiting ? `Waiting for ${esc(g.waitingOn.join(', '))} to discard…` : isHost ? '' : `Waiting for the host to reveal ${next}…`}</p>`;
  }
  let lower = '';
  if (g.hands) {
    const winIds = new Set(paying ? paying.winners.map((w) => w.id) : []);
    lower += `<div class="panel"><h2>Hands</h2><ul class="plist hands">${g.hands.map((h) => `<li class="${winIds.has(h.id) ? 'winner' : ''}">
      <span class="nm">${esc(h.name)}${h.id === view.you ? '<span class="tag gold">You</span>' : ''}</span>${mini(h.cards)}</li>`).join('')}</ul></div>`;
  }
  if (g.stage === 'done') {
    const carried = view.carry.reduce((a, b) => a + b, 0);
    lower = `<div class="panel"><h2>Game ${g.no} results</h2><table class="sum">${g.results.map((r) => `<tr><td><b>${esc(r.label)}</b></td>
        <td>${r.winners.map((w) => (w.id === CARRY_ID ? '<span class="co">Carryover</span>' : esc(w.name))).join(', ')}<br><span class="muted small">${esc(r.handName)}</span></td>
        <td>${money(r.pot)}</td></tr>`).join('')}</table></div>
      <div class="panel"><h2>This game</h2><ul class="plist">${g.net.map((n) => `<li><span class="nm">${esc(n.name)}</span>${balHtml(n.cents)}</li>`).join('')}</ul>
      ${carried ? `<p class="co small" style="margin:8px 0 0">${money(carried)} carries over to the next game. Rules stay locked until it is won.</p>` : ''}</div>` + lower;
  }
  let bar = '';
  if (isHost) {
    if (g.stage === 'done') {
      bar = `${view.plan.ok ? '<button class="btn" data-act="deal">Deal again, same rules</button>' : `<div class="plan no"><p>${esc(view.plan.reason)}</p></div>`}
        <div class="two"><button class="btn ghost sm" data-act="lobby">${view.locked ? 'Players and rules' : 'Change rules'}</button><button class="btn danger sm" data-act="end">End session</button></div>`;
    } else if (waiting) {
      bar = `<button class="btn ghost" data-act="autoDiscard">Auto-discard for ${waiting} slow player${waiting === 1 ? '' : 's'}</button>`;
    } else {
      const label = { pre: 'Reveal the flop', flop: 'Reveal the turn', turn: 'Reveal the river', river: 'Showdown', showdown: `Next ▸ (${g.payIndex} of ${g.nBoards} paid)` }[g.stage];
      bar = `<button class="btn" data-act="next">${label}</button>`;
    }
  }
  return `
    <div class="info">Game ${g.no} · <b>${esc(rulesLine(g.rules, g.rows))}</b> · ${money(g.perPlayer)} in each</div>
    ${renderGrid(g)}
    ${mid}
    ${renderMyHand(g)}
    ${lower}
    <div class="panel"><h2>Balances</h2>${renderPlayers(isHost, false)}</div>
    ${bar ? `<div class="bar"><div class="in">${bar}</div></div>` : ''}`;
}

function renderEnded(isHost) {
  const sorted = view.players.slice().sort((a, b) => b.balance - a.balance);
  return `
    <div class="hero" style="padding-top:8px"><h1>Settle <span>up</span></h1><p>The session is over. Chips are play money: settle between yourselves.</p></div>
    <div class="panel"><h2>Who pays who</h2>
      ${view.settle && view.settle.length
    ? `<ul class="plist settle">${view.settle.map((t) => `<li><span class="nm"><b>${esc(t.from)}</b><span class="arrow">pays</span><b>${esc(t.to)}</b></span><span class="bal">${money(t.cents)}</span></li>`).join('')}</ul>`
    : '<p class="muted" style="margin:0">Everyone is even. Nobody owes anything.</p>'}
    </div>
    <div class="panel"><h2>Final balances</h2><ul class="plist">${sorted.map((p) => `<li><span class="nm">${esc(p.name)}${p.id === view.you ? '<span class="tag gold">You</span>' : ''}</span>${balHtml(p.balance)}</li>`).join('')}</ul>
      ${view.refund ? `<p class="co small" style="margin:8px 0 0">${money(view.refund.total)} of unclaimed carryover was split evenly between the ${view.refund.count} players of the last game.</p>` : ''}
    </div>
    <button class="btn ${isHost ? '' : 'ghost'}" data-act="${isHost ? 'fresh' : 'home'}">${isHost ? 'Start a new session' : 'Back to start'}</button>`;
}

// ---------- boot ----------

(function boot() {
  let saved = null;
  try { saved = JSON.parse(ls.get('xw_host')); } catch { /* none */ }
  if (saved && saved.hostId === pid && saved.code === urlRoom && urlRoom) {
    session = saved;
    startHost(false);
  } else if (urlRoom && myName && ls.get('xw_room') === urlRoom) {
    startClient(urlRoom);
  } else {
    render();
  }
})();
