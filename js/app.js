// Crossword Slots — phone UI and real-time sync.
// The host's phone runs the game (session.js) and sends every other phone only what
// that player is allowed to see. Phones talk directly to each other through PeerJS.

import * as S from './session.js';
import { cryptoRnd, money, variantName, CARRY_ID } from './engine.js';

const PEER_PREFIX = 'xwslots-v1-';
const PAY_MS = 3200;
const AWAY_MSG = 'The host is away. The game is paused until they come back.';
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  json(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
};

const randomId = (n, alphabet) => Array.from({ length: n }, () => alphabet[cryptoRnd(alphabet.length)]).join('');
const newCode = () => randomId(4, 'ABCDEFGHJKLMNPQRSTUVWXYZ');

let did = ls.get('xw_pid'); // this phone
if (!did) { did = randomId(12, 'abcdefghijklmnopqrstuvwxyz0123456789'); ls.set('xw_pid', did); }
let myName = ls.get('xw_name') || '';
const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

let role = null;      // 'host' | 'client'
let session = null;   // host only: the real game state
let view = null;      // what this phone may see
let roomCode = '';
let peer = null;
let hostConn = null;  // client only
const conns = new Map(); // host only: device id -> { conn, last }
let net = { status: 'idle', msg: '' };
let lastMsg = 0;
let retryTimer = null;
let autoTimer = null;
let handover = null;  // host only: a pass-the-host in flight
let wake = null;
const ui = { sel: null, seenGame: 0, seen: new Set(), board: null };

// ---------- helpers ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SUIT = { c: '♣', d: '♦', h: '♥', s: '♠' };

function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { $toast.hidden = true; }, 2800);
}

function cardHtml(c, cls = '', attrs = '') {
  const red = c[1] === 'd' || c[1] === 'h';
  const rank = c[0] === 'T' ? '10' : c[0];
  return `<div class="card ${red ? 'red' : ''} ${cls}" ${attrs}><span class="r">${rank}</span><span class="s">${SUIT[c[1]]}</span></div>`;
}
const mini = (cards) => `<span class="mini">${cards.map((c) => cardHtml(c)).join('')}</span>`;
const balHtml = (c) => `<span class="bal ${c > 0 ? 'pos' : c < 0 ? 'neg' : ''}">${c > 0 ? '+' : ''}${money(c)}</span>`;
const joinUrl = () => `${location.origin}${location.pathname}?room=${roomCode}`;
const hasPeer = () => typeof window.Peer === 'function';
const labelFor = (layout, i) => (layout === 'crossword' ? (i < 5 ? `${i + 1} Across` : `${i - 4} Down`) : `Board ${i + 1}`);

function pct(share) {
  if (share >= 0.995) return '100%';
  if (share <= 0) return '0%';
  if (share < 0.01) return '<1%';
  return `${Math.min(99, Math.round(share * 100))}%`;
}

function rulesLine(r, rows) {
  const parts = [variantName(r)];
  if (r.hole === 5 && !r.free) parts.push(r.discardTiming === 'pre' ? 'discard before flop' : 'discard after flop');
  parts.push(r.layout === 'crossword' ? 'Crossword' : `Slots × ${rows ?? r.boards}`);
  if (r.carryover) parts.push('Carryover');
  return parts.join(' · ');
}

// Ask the phone to keep its screen on while in a room (same thing video players do).
async function keepAwake() {
  try {
    if (role && 'wakeLock' in navigator && !document.hidden && (!wake || wake.released)) {
      wake = await navigator.wakeLock.request('screen');
    }
  } catch { /* not supported or refused: the screen may dim as usual */ }
}

// ---------- history kept on the host's phone ----------

let hist = ls.json('xw_hist') || [];
let histCache = null;

function histExtra() {
  if (histCache) return histCache;
  const totals = new Map();
  for (const h of hist) {
    for (const p of h.players) {
      const k = p.name.toLowerCase();
      const t = totals.get(k) || { name: p.name, cents: 0, sessions: 0 };
      t.cents += p.cents; t.sessions += 1; t.name = p.name;
      totals.set(k, t);
    }
  }
  const list = [...totals.values()].sort((a, b) => b.cents - a.cents);
  histCache = { past: hist.slice(-8).reverse(), totals: list, roster: list.map((t) => t.name) };
  return histCache;
}
function saveHist() { hist = hist.slice(-60); ls.set('xw_hist', JSON.stringify(hist)); histCache = null; }
function recordSession() {
  const id = `${session.code}-${session.startedAt}`;
  if (session.gameNo === 0 || hist.some((h) => h.id === id)) return;
  hist.push({ id, when: Date.now(), games: session.gameNo, players: session.players.filter((p) => !p.bot).map((p) => ({ name: p.name, cents: p.balance })) });
  saveHist();
}
function mergeHist(other) {
  for (const h of other || []) if (h && h.id && !hist.some((x) => x.id === h.id)) hist.push(h);
  hist.sort((a, b) => a.when - b.when);
  saveHist();
}

// ---------- host ----------

function saveSession() { ls.set('xw_host', JSON.stringify(session)); }

function commit() {
  saveSession();
  broadcast();
  clearTimeout(autoTimer);
  if (session.phase === 'play' && session.game.stage === 'showdown' && !document.hidden) {
    autoTimer = setTimeout(() => { S.advance(session); commit(); }, PAY_MS);
  }
}

function sendTo(c, msg) {
  if (c && c.conn.open) { try { c.conn.send(msg); } catch { /* dropped */ } }
}

function broadcast() {
  const online = new Set([session.hostId]);
  for (const [d, c] of conns) {
    const p = S.playerOf(session, d);
    if (p && c.conn.open) online.add(p);
  }
  const extra = histExtra();
  for (const [d, c] of conns) sendTo(c, { t: 'state', view: S.viewFor(session, S.playerOf(session, d), online, extra) });
  view = S.viewFor(session, session.hostId, online, extra);
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
  keepAwake();
  commit();
  openHostPeer(fresh);
}

function openHostPeer(fresh) {
  if (!hasPeer()) { net = { status: 'offline', msg: "Couldn't load the connection library, so friends can't join right now. You can still play against CPU players." }; render(); return; }
  if (peer) { try { peer.destroy(); } catch { /* gone */ } }
  conns.clear();
  net = { status: 'connecting', msg: '' };
  const p = new window.Peer(PEER_PREFIX + session.code, { debug: 0 });
  peer = p;
  p.on('open', () => { if (peer === p) { net = { status: 'online', msg: '' }; render(); } });
  p.on('connection', (conn) => {
    let cdid = null;
    const mine = () => cdid && conns.get(cdid) && conns.get(cdid).conn === conn;
    conn.on('data', (m) => {
      if (peer !== p || !m || typeof m !== 'object') return;
      if (m.t === 'hello') {
        cdid = String(m.did || '').slice(0, 40);
        if (!cdid || cdid === session.hostDid) { cdid = null; return; }
        const old = conns.get(cdid);
        if (old && old.conn !== conn) { try { old.conn.close(); } catch { /* gone */ } }
        conns.set(cdid, { conn, last: Date.now() });
        broadcast();
        return;
      }
      if (!mine()) return;
      const c = conns.get(cdid);
      c.last = Date.now();
      const pid = S.playerOf(session, cdid);
      let r = null;
      if (m.t === 'claim') r = S.claim(session, cdid, { id: m.id, name: m.name });
      else if (m.t === 'unclaim') r = S.unclaim(session, cdid);
      else if (m.t === 'leave') { if (pid) { S.unclaim(session, cdid); r = S.removePlayer(session, pid); } else r = {}; }
      else if (m.t === 'discard' && pid) r = S.discard(session, pid, m.idx);
      else if (m.t === 'sit' && pid) r = S.setSitOut(session, pid, !!m.on);
      else if (m.t === 'takeover-ack' && handover && handover.did === cdid) { finishHandover(); return; }
      if (r) { if (r.error) sendTo(c, { t: 'toast', msg: r.error }); commit(); }
    });
    conn.on('close', () => { if (mine()) { conns.delete(cdid); if (role === 'host') broadcast(); } });
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
        net = { status: 'connecting', msg: 'Opening the room…' };
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
  for (const [d, c] of conns) {
    if (Date.now() - c.last > 16000) { try { c.conn.close(); } catch { /* gone */ } conns.delete(d); changed = true; continue; }
    sendTo(c, { t: 'ping' });
  }
  if (changed) broadcast();
}

// Pass the host: send the whole game to another phone, wait for it to confirm, then step down.
function startHandover(toId) {
  const toDid = S.deviceOf(session, toId);
  const c = toDid && conns.get(toDid);
  if (!c || !c.conn.open) { toast('They need to be in the room on their phone to become host.'); return; }
  const copy = JSON.parse(JSON.stringify(session));
  const r = S.passHost(copy, toId);
  if (r.error) { toast(r.error); return; }
  clearTimeout(autoTimer);
  handover = { did: toDid, timer: setTimeout(() => { handover = null; toast("Couldn't reach their phone. You are still the host."); commit(); }, 7000) };
  sendTo(c, { t: 'takeover', session: copy, hist });
  net = { status: 'connecting', msg: 'Passing the host…' };
  render();
}

function finishHandover() {
  clearTimeout(handover.timer);
  handover = null;
  ls.del('xw_host');
  session = null;
  try { peer.destroy(); } catch { /* gone */ }
  peer = null;
  conns.clear();
  role = 'client';
  net = { status: 'connecting', msg: 'Host passed. Rejoining the room…' };
  render();
  setTimeout(() => startClient(roomCode), 2500);
}

// ---------- client ----------

function startClient(code) {
  role = 'client';
  roomCode = code;
  ls.set('xw_room', code);
  history.replaceState(null, '', `?room=${code}`);
  keepAwake();
  connectClient();
}

function retryClient(msg) {
  if (role !== 'client') return;
  net = { status: 'connecting', msg: msg || (view ? AWAY_MSG : 'Connecting…') };
  render();
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connectClient, 2500);
}

function becomeHost(m) {
  session = m.session;
  mergeHist(m.hist);
  try { hostConn.send({ t: 'takeover-ack' }); } catch { /* dropped */ }
  setTimeout(() => {
    try { peer.destroy(); } catch { /* gone */ }
    peer = null;
    hostConn = null;
    clearTimeout(retryTimer);
    ls.del('xw_room');
    toast('You are the host now.');
    startHost(false);
  }, 600);
}

function connectClient() {
  clearTimeout(retryTimer);
  if (role !== 'client') return;
  if (!hasPeer()) { net = { status: 'offline', msg: "Couldn't load the connection library. Check your internet and reload." }; render(); return; }
  if (peer) { try { peer.destroy(); } catch { /* gone */ } }
  if (net.status !== 'connecting') net = { status: 'connecting', msg: '' };
  render();
  const p = new window.Peer({ debug: 0 });
  peer = p;
  p.on('open', () => {
    if (peer !== p) return;
    const c = p.connect(PEER_PREFIX + roomCode, { reliable: true, serialization: 'json' });
    hostConn = c;
    c.on('open', () => { lastMsg = Date.now(); c.send({ t: 'hello', did }); });
    c.on('data', (m) => {
      if (peer !== p || !m) return;
      lastMsg = Date.now();
      if (m.t === 'state') {
        view = m.view;
        net = { status: 'online', msg: '' };
        const me = view.players.find((x) => x.id === view.you);
        if (me && me.name !== myName) { myName = me.name; ls.set('xw_name', myName); }
        render();
      } else if (m.t === 'ping') { try { c.send({ t: 'pong' }); } catch { /* dropped */ } }
      else if (m.t === 'away') { net = { status: 'connecting', msg: AWAY_MSG }; render(); }
      else if (m.t === 'toast') toast(String(m.msg));
      else if (m.t === 'takeover' && m.session && m.session.hostDid === did) becomeHost(m);
    });
    c.on('close', () => { if (peer === p) retryClient(); });
    c.on('error', () => { if (peer === p) retryClient(); });
  });
  p.on('error', (e) => {
    if (peer !== p) return;
    if (e.type === 'peer-unavailable') {
      retryClient(view ? AWAY_MSG : `Can't reach room ${roomCode}. Check the code, and make sure the host has the game open on their phone. Trying again…`);
    } else retryClient(view ? undefined : 'Connection problem. Trying again…');
  });
  p.on('disconnected', () => { if (peer === p && !(hostConn && hostConn.open)) retryClient(); });
}

function clientHeartbeat() {
  if (role !== 'client' || net.status !== 'online') return;
  if (Date.now() - lastMsg > 13000) retryClient();
}

function sendHost(msg) {
  if (hostConn && hostConn.open) { try { hostConn.send(msg); return true; } catch { /* dropped */ } }
  toast('Not connected right now. Try again in a moment.');
  return false;
}

setInterval(() => { hostHeartbeat(); clientHeartbeat(); }, 4000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (role === 'host') { clearTimeout(autoTimer); for (const c of conns.values()) sendTo(c, { t: 'away' }); }
    return;
  }
  keepAwake();
  if (role === 'host' && !handover) {
    if (!peer || peer.disconnected || peer.destroyed) openHostPeer(false);
    commit();
  }
  if (role === 'client' && Date.now() - lastMsg > 8000) connectClient();
});

// ---------- actions ----------

function readName() {
  const el = document.getElementById('name');
  const v = (el ? el.value : myName).replace(/\s+/g, ' ').trim().slice(0, 16);
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

const isHost = () => role === 'host';

const actions = {
  create() {
    if (!readName()) return;
    session = S.newSession(newCode(), did, myName);
    startHost(true);
  },
  resume() { session = ls.json('xw_host'); startHost(false); },
  join() {
    const el = document.getElementById('code');
    const code = (el ? el.value : '').toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) { toast('Enter the 4-letter room code.'); return; }
    startClient(code);
  },
  fillName(name) { const el = document.getElementById('name'); if (el) el.value = name; },
  home() { ls.del('xw_room'); location.href = location.pathname; },
  share,
  // checking in (phones that are not the host)
  claimId(id) { sendHost({ t: 'claim', id }); },
  claimName(name) { sendHost({ t: 'claim', name }); },
  claimNew() { if (readName()) sendHost({ t: 'claim', name: myName }); },
  switchPlayer() { if (window.confirm('Check in as a different player? Your seat and balance stay with this name.')) sendHost({ t: 'unclaim' }); },
  leave() {
    if (!window.confirm('Leave this room?')) return;
    if (hostConn && hostConn.open) { try { hostConn.send({ t: 'leave' }); } catch { /* gone */ } }
    ls.del('xw_room');
    setTimeout(() => { location.href = location.pathname; }, 200);
  },
  // host only
  rule(key, val) {
    if (!isHost()) return;
    let patch;
    if (key === 'variant') patch = { hole: parseInt(val, 10), free: val === '5f' };
    else if (key === 'layout' || key === 'discardTiming') patch = { [key]: val };
    else if (key === 'carryover' || key === 'showOdds') patch = { [key]: val === '1' };
    else patch = { [key]: Number(val) };
    hostAct(S.setRules(session, patch));
  },
  addBot() { if (isHost()) hostAct(S.addBot(session)); },
  kick(id) { if (isHost()) hostAct(S.removePlayer(session, id)); },
  makeHost(id) {
    if (!isHost()) return;
    const p = session.players.find((x) => x.id === id);
    if (p && window.confirm(`Make ${p.name} the host? Their phone will run the game from now on.`)) startHandover(id);
  },
  deal() { if (isHost()) { ui.sel = null; ui.board = null; hostAct(S.deal(session, cryptoRnd)); } },
  next() { if (isHost()) hostAct(S.advance(session)); },
  autoDiscard() { if (isHost()) hostAct(S.autoDiscardRest(session)); },
  lobby() { if (isHost()) hostAct(S.toLobby(session)); },
  end() {
    if (!isHost() || !window.confirm('End the session and show the settle-up?')) return;
    const r = S.endSession(session);
    if (!r.error) recordSession();
    hostAct(r);
  },
  fresh() { ls.del('xw_host'); location.href = location.pathname; },
  // everyone
  sit(on) {
    if (isHost()) hostAct(S.setSitOut(session, session.hostId, on === '1'));
    else sendHost({ t: 'sit', on: on === '1' });
  },
  board(i) { ui.board = ui.board === Number(i) ? null : Number(i); render(); },
  pick(i) { ui.sel = ui.sel === Number(i) ? null : Number(i); render(); },
  discard() {
    if (ui.sel === null) return;
    const idx = ui.sel;
    ui.sel = null;
    if (isHost()) hostAct(S.discard(session, session.hostId, idx));
    else if (!sendHost({ t: 'discard', idx })) render();
  },
};

$app.addEventListener('click', (e) => {
  keepAwake();
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el.dataset.a, el.dataset.b);
});
$app.addEventListener('change', (e) => {
  if (e.target.id === 'stake' && isHost()) {
    const v = Math.round(parseFloat(e.target.value) * 100);
    if (Number.isFinite(v) && v >= 1) hostAct(S.setRules(session, { stakeCents: v }));
    else { toast('Enter a stake above $0.'); render(); }
  }
});
$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'code') actions.join();
  else if (e.target.id === 'name' && view && !view.you) actions.claimNew();
  else if (e.target.id === 'stake') e.target.blur();
});

// ---------- rendering ----------

function render() {
  if (!view) { $app.innerHTML = renderHome(); return; }
  const host = view.hostId === view.you;
  let body;
  if (view.phase === 'ended') body = renderEnded(host);
  else if (!view.you) body = renderPicker();
  else if (view.phase === 'lobby' || !view.game) body = renderLobby(host);
  else body = renderTable(host);
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

const HERO = `<div class="hero"><div class="suits">♠<i>♥</i>♣<i>♦</i></div><h1>Crossword <span>Slots</span></h1>
  <p>Quintuple Pineapple Omaha Crossword 2-Card Carryover Slots Poker</p></div>`;

function renderHome() {
  if (role === 'client') {
    return `${HERO}<div class="panel center"><p><span class="dot wait" style="display:inline-block"></span> Joining room <b>${esc(roomCode)}</b>…</p>
      <p class="muted">${esc(net.msg || 'Connecting to the host’s phone.')}</p>
      <button class="btn ghost" data-act="home">Cancel</button></div>`;
  }
  const saved = ls.json('xw_host');
  const resumable = saved && saved.v === 2 && saved.phase !== 'ended' && saved.hostDid === did;
  const names = histExtra().roster.slice(0, 8);
  return `${HERO}
    ${resumable ? `<div class="panel"><button class="btn" data-act="resume">Resume your room ${esc(saved.code)}</button></div>` : ''}
    <div class="panel"><label class="field" for="name">Your name</label>
      <input class="text" id="name" maxlength="16" autocomplete="off" placeholder="Name" value="${esc(myName)}">
      ${names.length ? `<div class="chips">${names.map((n) => `<button class="pill" data-act="fillName" data-a="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      <button class="btn mt" data-act="create">Create a room</button>
      <div class="or">or join a friend</div>
      <div class="row"><input class="text code grow" id="code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="CODE">
      <button class="btn sm" data-act="join" style="padding:13px 18px">Join</button></div>
    </div>
    <p class="muted center">Play money only. Create a room and add CPU players to try it solo.</p>`;
}

function renderPicker() {
  const here = view.players.filter((p) => !p.bot && p.id !== view.hostId);
  const taken = new Set(view.players.map((p) => p.name.toLowerCase()));
  const known = view.roster.filter((n) => !taken.has(n.toLowerCase())).slice(0, 12);
  const host = view.players.find((p) => p.id === view.hostId);
  const fresh = myName && !taken.has(myName.toLowerCase()) ? myName : '';
  return `<div class="panel"><h2>Who are you?</h2>
      <p class="muted" style="margin:0 0 10px">${esc(host ? host.name : 'The host')}'s room. Pick your name. Tapped the wrong one? You can switch any time without leaving.</p>
      ${here.length ? `<div class="who">${here.map((p) => `<button class="whob" data-act="claimId" data-a="${esc(p.id)}"><b>${esc(p.name)}</b><span>${p.online ? 'on another phone now' : p.active ? 'in this room' : 'left earlier'} · ${money(p.balance)}</span></button>`).join('')}</div>` : ''}
      ${known.length ? `<div class="chips">${known.map((n) => `<button class="pill" data-act="claimName" data-a="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      <label class="field mt" for="name">${here.length || known.length ? 'Not on the list? New player' : 'Your name'}</label>
      <div class="row"><input class="text grow" id="name" maxlength="16" autocomplete="off" placeholder="Name" value="${esc(fresh)}">
      <button class="btn sm" data-act="claimNew" style="padding:13px 18px">Join</button></div>
    </div>
    <button class="btn ghost" data-act="home">Leave room</button>`;
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

function renderPlayers(host, manage) {
  return `<ul class="plist">${view.players.map((p) => `<li class="${p.active && p.online ? '' : 'off'}">
      <span class="nm">${esc(p.name)}${p.id === view.you ? '<span class="tag gold">You</span>' : ''}${p.id === view.hostId ? '<span class="tag">Host</span>' : ''}${p.bot ? '<span class="tag">CPU</span>' : ''}${!p.active ? '<span class="tag">Left</span>' : !p.online ? '<span class="tag">Offline</span>' : ''}${p.active && p.sitOut ? '<span class="tag">Sitting out</span>' : p.active && view.game && view.phase === 'play' && !p.inGame ? '<span class="tag">Next game</span>' : ''}${p.waiting ? '<span class="tag gold">Discarding</span>' : ''}</span>
      ${balHtml(p.balance)}
      ${host && manage && p.active && !p.bot && p.online && p.id !== view.hostId ? `<button class="x wide" data-act="makeHost" data-a="${esc(p.id)}">Make host</button>` : ''}
      ${host && manage && p.active && p.id !== view.hostId ? `<button class="x" data-act="kick" data-a="${esc(p.id)}" aria-label="Remove">✕</button>` : ''}
    </li>`).join('')}</ul>`;
}

function renderSelf(host) {
  const sit = `<button class="btn ghost sm grow" data-act="sit" data-a="${view.sitOut ? 0 : 1}">${view.sitOut ? 'Deal me back in' : 'Sit out and watch'}</button>`;
  return `<div class="row mt">${sit}${host ? '' : '<button class="btn ghost sm grow" data-act="switchPlayer">Not you? Switch</button>'}</div>`;
}

function renderHistory() {
  const d = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const chips = (list) => list.map((n) => `<span class="hc ${n.cents > 0 ? 'pos' : n.cents < 0 ? 'neg' : ''}">${esc(n.name)} ${n.cents > 0 ? '+' : ''}${money(n.cents)}</span>`).join('');
  if (!view.log.length && !view.past.length) return '';
  return `<details class="panel hist"><summary>History</summary>
    ${view.log.length ? `<h3>This session</h3>${view.log.slice().reverse().map((l) => `<div class="hrow"><div class="muted small">Game ${l.no} · ${esc(l.line)}${l.carried ? ` · <span class="co">${money(l.carried)} carried</span>` : ''}</div><div>${chips(l.net)}</div></div>`).join('')}` : ''}
    ${view.totals.length ? `<h3>All-time on the host's phone</h3><div class="hrow">${chips(view.totals)}</div>` : ''}
    ${view.past.length ? `<h3>Past sessions</h3>${view.past.map((h) => `<div class="hrow"><div class="muted small">${d(h.when)} · ${h.games} game${h.games === 1 ? '' : 's'}</div><div>${chips(h.players)}</div></div>`).join('')}` : ''}
  </details>`;
}

function renderLobby(host) {
  const r = view.rules;
  const lock = view.locked;
  const dis = !host || lock;
  const nIn = view.players.filter((p) => p.active && !p.sitOut).length;
  const rules = host
    ? `${lock ? '<div class="lock">🔒 Rules are locked until the carryover pot has been played out.</div>' : ''}
      <div class="opt"><div class="lab"><span>Hole cards</span></div>${seg('variant', r.hole === 5 && r.free ? '5f' : r.hole, [[2, '2', "Hold'em"], [4, '4', 'Omaha'], [5, '5', 'Pineapple'], ['5f', '5', 'Any (keep all)']], dis)}</div>
      ${r.hole === 5 && !r.free ? `<div class="opt"><div class="lab"><span>Discard one card</span></div>${seg('discardTiming', r.discardTiming, [['pre', 'Before the flop'], ['post', 'After the flop']], dis)}</div>` : ''}
      ${r.hole === 5 && r.free ? '<p class="muted small" style="margin:-4px 0 10px">Keep all five. Each board plays your best hand using 0, 1 or 2 of them.</p>' : ''}
      <div class="opt"><div class="lab"><span>Board layout</span></div>${seg('layout', r.layout, [['slots', 'Slots', 'rows only'], ['crossword', 'Crossword', '5 across + 5 down']], dis)}</div>
      ${r.layout === 'slots' ? `<div class="opt"><div class="lab"><span>Boards</span></div>${seg('boards', r.boards, [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']], dis)}</div>` : ''}
      <div class="opt"><div class="lab"><span>Carryover (the Pocket)</span></div>${seg('carryover', r.carryover ? 1 : 0, [[0, 'Off'], [1, 'On']], dis)}</div>
      <div class="opt"><div class="lab"><span>Show win %</span>${!r.showOdds && view.oddsOn ? '<span class="muted small">always on vs CPUs</span>' : ''}</div>${seg('showOdds', r.showOdds ? 1 : 0, [[0, 'Off'], [1, 'On']], false)}</div>
      <div class="opt row"><div class="grow">Base stake per player</div><div class="stake">$<input class="text" id="stake" type="number" inputmode="decimal" min="0.01" step="0.01" value="${(r.stakeCents / 100).toFixed(2)}" ${dis ? 'disabled' : ''}></div></div>`
    : `<p style="margin:0 0 8px"><b>${esc(rulesLine(r))}</b><br><span class="muted">Base stake ${money(r.stakeCents)} per player · win % ${view.oddsOn ? 'on' : 'off'}</span></p>`;
  return `
    <div class="panel"><h2>Players (${nIn} in)</h2>${renderPlayers(host, true)}
      ${renderSelf(host)}
      ${host ? '<div class="row mt"><button class="btn ghost sm grow" data-act="addBot">+ Add CPU player</button><button class="btn ghost sm grow" data-act="share">Invite friends</button></div>' : ''}
    </div>
    <div class="panel"><h2>Rules for the next game</h2>${rules}${renderPlan()}
      <p class="muted small" style="margin:8px 0 0">Rounding: everything is counted in cents. If a pot doesn't split evenly, the extra cents go to the lowest-numbered boards, and on a tied board to the tied players in seat order (the Pocket last).</p>
    </div>
    ${renderHistory()}
    ${host ? '' : '<p class="status">Waiting for the host to deal…</p><button class="btn ghost" data-act="leave">Leave room</button>'}
    ${host ? `<div class="bar"><div class="in">
      <button class="btn" data-act="deal" ${view.plan.ok ? '' : 'disabled'}>Deal${view.game ? ' next game' : ''}</button>
      <button class="btn danger sm" style="width:100%" data-act="end">End session and settle up</button>
    </div></div>` : ''}`;
}

function boardCells(g, i) {
  const cw = g.rules.layout === 'crossword';
  return (r, c) => (cw && i >= 5 ? c === i - 5 : r === i);
}

function renderGrid(g) {
  const cw = g.rules.layout === 'crossword';
  if (ui.seenGame !== g.no) { ui.seenGame = g.no; ui.seen = new Set(); ui.board = null; }
  if (ui.board !== null && ui.board >= g.nBoards) ui.board = null;
  const paying = g.stage === 'showdown' && g.results && g.results.length ? g.results[g.results.length - 1] : null;
  const lit = paying ? paying.index : -1;
  const winCards = new Set(paying ? paying.winners.flatMap((w) => w.cards) : []);
  const inLit = lit >= 0 ? boardCells(g, lit) : () => false;
  const inPick = ui.board !== null ? boardCells(g, ui.board) : () => false;
  // order new cards the way they are dealt: flop row by row, then turn, then river
  const fresh = [];
  for (const cols of [[0, 1, 2], [3], [4]]) {
    for (let r = 0; r < g.rows; r++) for (const c of cols) if (g.grid[r][c] && !ui.seen.has(g.grid[r][c])) fresh.push(g.grid[r][c]);
  }
  const lab = (i, text, top) => {
    const mine = g.odds && g.odds.boards[i] ? g.odds.boards[i].find((x) => x.id === view.you) : null;
    return `<button class="glab ${top ? 'top' : ''} ${g.carryIn[i] ? 'carry' : ''} ${lit === i ? 'lit' : ''} ${ui.board === i ? 'pick' : ''}" data-act="board" data-a="${i}">
      <b>${text}</b><span class="pot">${money(g.pots[i])}</span>${mine ? `<span class="pc">${pct(mine.share)}</span>` : ''}</button>`;
  };
  let html = '<div class="grid">';
  if (cw) {
    html += '<div></div>';
    for (let c = 0; c < 5; c++) html += lab(5 + c, `${c + 1}↓`, true);
  }
  for (let r = 0; r < g.rows; r++) {
    html += lab(r, `${r + 1}${cw ? '→' : ''}`, false);
    for (let c = 0; c < 5; c++) {
      const card = g.grid[r][c];
      if (!card) { html += `<div class="slot ${inPick(r, c) ? 'pick' : ''}"></div>`; continue; }
      const k = fresh.indexOf(card);
      let cls = k >= 0 ? 'deal' : '';
      if (paying) cls += inLit(r, c) ? (winCards.has(card) ? ' win' : '') : ' dim';
      else if (ui.board !== null) cls += inPick(r, c) ? ' pick' : ' dim';
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
  if (carry && !real.length) return `The Pocket wins. <span class="co">${money(carry.cents)} carries to ${esc(res.label)} next game.</span>`;
  const names = real.map((w) => `${esc(w.name)} ${real.length > 1 || carry ? money(w.cents) : ''}`.trim()).join(', ');
  if (carry) return `Split: ${names}. <span class="co">The Pocket's ${money(carry.cents)} carries over.</span>`;
  return real.length > 1 ? `Split: ${names}` : `${names} wins ${money(real[0].cents)}`;
}

const who = (x) => `${esc(x.name)}${x.id === view.you ? '<span class="tag gold">You</span>' : ''}`;

function renderBoardDetail(g) {
  const i = ui.board;
  if (i === null) return '';
  const res = g.results ? g.results.find((r) => r.index === i) : null;
  const odds = g.odds && g.odds.boards[i];
  let body;
  if (res) {
    const won = new Map(res.winners.map((w) => [w.id, w.cents]));
    body = `<ul class="plist">${res.all.map((x) => `<li class="${won.has(x.id) ? 'winner' : ''}"><span class="nm">${who(x)}<br><span class="muted small">${esc(x.handName)}${won.has(x.id) ? ` · <span class="co">${x.id === CARRY_ID ? 'carries' : 'wins'} ${money(won.get(x.id))}</span>` : ''}</span></span>${mini(x.cards)}</li>`).join('')}</ul>`;
  } else if (odds) {
    body = odds.map((x) => `<div class="orow ${x.id === CARRY_ID ? 'pk' : ''}"><span class="nm">${who(x)}</span><span class="track"><i style="width:${Math.round(x.share * 100)}%"></i></span><b>${pct(x.share)}</b></div>`).join('')
      + '<p class="muted small" style="margin:8px 0 0">Chance of winning this board right now. A split counts as a share.</p>';
  } else {
    body = `<p class="muted" style="margin:0">${g.oddsWait ? 'Win % appears once everyone has discarded.' : g.hands ? 'This board has not been paid yet.' : 'Win % is turned off for this game.'}</p>`;
  }
  return `<div class="panel detail"><h2>${esc(g.labels[i])} · ${money(g.pots[i])} pot${g.carryIn[i] ? ` <span class="co">(${money(g.carryIn[i])} carried in)</span>` : ''}</h2>${body}</div>`;
}

function renderEV(g) {
  if (!g.odds || !g.odds.ev) return '';
  return `<div class="panel"><h2>Expected winnings right now</h2>
    ${g.odds.ev.map((x) => `<div class="orow ${x.id === CARRY_ID ? 'pk' : ''}"><span class="nm">${who(x)}</span><span class="track"><i style="width:${Math.round(x.share * 100)}%"></i></span><b>${money(x.cents)}</b></div>`).join('')}
    <p class="muted small" style="margin:8px 0 0">Each board's pot times the chance of winning it, added up. Everyone put in ${money(g.perPlayer)}.${g.odds.ev.some((x) => x.id === CARRY_ID) ? " The Pocket's share would carry over." : ''}</p></div>`;
}

function renderMyHand(g) {
  if (!g.myHole) return `<p class="status">${view.sitOut ? "You're sitting out and watching." : "You'll be dealt in next game."}</p>`;
  if (g.stage === 'showdown' || g.stage === 'done') return '';
  const cards = g.myHole.map((c, i) => {
    if (g.needDiscard) return cardHtml(c, `tap ${ui.sel === i ? 'sel' : ''}`, `data-act="pick" data-a="${i}"`);
    return cardHtml(c, g.myDiscard === i ? 'gone' : '');
  }).join('');
  let extra = '';
  if (g.needDiscard) {
    extra = `<p class="status" style="margin-bottom:6px">Tap the card you want to throw away.</p>
      <button class="btn" data-act="discard" ${ui.sel === null ? 'disabled' : ''}>Discard${ui.sel === null ? '' : ' this card'}</button>`;
  }
  const how = g.rules.hole === 2 ? '' : g.rules.free ? ' · play 0, 1 or 2' : ' · must play exactly 2';
  return `<div class="handlab">Your cards${how}</div><div class="hand n${g.myHole.length}">${cards}</div>${extra}`;
}

function renderTable(host) {
  const g = view.game;
  const grid = renderGrid(g);
  const paying = g.stage === 'showdown' ? g.results[g.results.length - 1] : null;
  const waiting = g.waitingOn.length;
  let mid = '';
  if (paying) {
    mid = `<div class="banner"><div class="t">${esc(paying.label)} · ${money(paying.pot)} pot</div>
      <div class="w">${winnersText(paying)}</div>
      <div class="h">${esc(paying.handName)} ${mini(paying.winners[0].cards)}</div></div>`;
  } else if (g.stage !== 'done') {
    const next = { pre: 'the flop', flop: 'the turn', turn: 'the river', river: 'the showdown' }[g.stage];
    const line = waiting ? `Waiting for ${esc(g.waitingOn.join(', '))} to discard…` : host ? '' : `Waiting for the host to reveal ${next}…`;
    if (line) mid = `<p class="status">${line}</p>`;
  }
  const hint = ui.board === null && (g.odds || g.results)
    ? `<p class="hint">Tap a board's number to see ${g.results ? 'every hand on it' : "everyone's chances"}.</p>` : '';
  let lower = '';
  if (g.hands) {
    const winIds = new Set(paying ? paying.winners.map((w) => w.id) : []);
    lower += `<div class="panel"><h2>Hands</h2><ul class="plist hands">${g.hands.map((h) => `<li class="${winIds.has(h.id) ? 'winner' : ''}">
      <span class="nm">${who(h)}</span>${mini(h.cards)}</li>`).join('')}</ul></div>`;
  }
  if (g.stage === 'done') {
    const carried = view.carry.reduce((a, b) => a + b, 0);
    lower = `<div class="panel"><h2>Game ${g.no} results</h2><table class="sum">${g.results.map((r) => `<tr data-act="board" data-a="${r.index}"><td><b>${esc(r.label)}</b></td>
        <td>${r.winners.map((w) => (w.id === CARRY_ID ? '<span class="co">The Pocket</span>' : esc(w.name))).join(', ')}<br><span class="muted small">${esc(r.handName)}</span></td>
        <td>${money(r.pot)}</td></tr>`).join('')}</table></div>
      <div class="panel"><h2>This game</h2><ul class="plist">${g.net.map((n) => `<li><span class="nm">${esc(n.name)}</span>${balHtml(n.cents)}</li>`).join('')}</ul>
      ${carried ? `<p class="co small" style="margin:8px 0 0">${money(carried)} carries over to the next game. Rules stay locked until it is won.</p>` : ''}</div>` + lower;
  }
  let bar = '';
  if (host) {
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
    ${grid}
    ${hint}
    ${renderBoardDetail(g)}
    ${mid}
    ${renderMyHand(g)}
    ${renderEV(g)}
    ${lower}
    <div class="panel"><h2>Balances</h2>${renderPlayers(host, false)}${renderSelf(host)}</div>
    ${bar ? `<div class="bar"><div class="in">${bar}</div></div>` : ''}`;
}

function renderEnded(host) {
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
    ${renderHistory()}
    <button class="btn ${host ? '' : 'ghost'}" data-act="${host ? 'fresh' : 'home'}">${host ? 'Start a new session' : 'Back to start'}</button>`;
}

// ---------- boot ----------

(function boot() {
  const saved = ls.json('xw_host');
  if (saved && saved.v !== 2) ls.del('xw_host'); // from an older version of the game
  if (urlRoom && saved && saved.v === 2 && saved.hostDid === did && saved.code === urlRoom) {
    session = saved;
    startHost(false);
  } else if (urlRoom) {
    startClient(urlRoom);
  } else {
    render();
  }
})();
