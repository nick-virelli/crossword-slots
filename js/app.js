// Crossword Slots — phone UI and real-time sync.
// The host's phone runs the game (session.js) and sends every other phone only what
// that player is allowed to see. Phones talk directly to each other through PeerJS.
//
// Words: a GAME is the whole sitting; a ROUND is one deal of the deck.

import * as S from './session.js?v=1794870668';
import { cryptoRnd, money, variantName, CARRY_ID, makeDeck, playMode } from './engine.js?v=1794870668';
import { outlook } from './odds.js?v=1794870668';

const PEER_PREFIX = 'xwslots-v1-';
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
let handover = null;  // host only: a pass-the-host in flight
let wake = null;
const ui = { sel: null, seenGame: 0, seen: new Set(), board: null, sheet: null };

// ---------- this phone's own settings: look, deck colours, sound ----------

// TEMPORARY: five complete looks to choose between. Once one is picked, delete the others
// from style.css, remove the Look picker from the settings sheet, and hard-code the winner.
const THEMES = [['felt', 'Felt'], ['paper', 'Newsprint'], ['mono', 'Terminal'], ['neon', 'Neon'], ['block', 'Block']];
const prefs = { theme: 'felt', deck4: false, sound: true, ...(ls.json('xw_prefs') || {}) };
function applyPrefs() {
  if (!THEMES.some((t) => t[0] === prefs.theme)) prefs.theme = 'felt';
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.deck = prefs.deck4 ? '4' : '2';
  ls.set('xw_prefs', JSON.stringify(prefs));
}
applyPrefs();

// ---------- sound and vibration ----------
// Every bit of feedback goes through fx(name). When a new game event is added (a new mode,
// a new button with a consequence, a new kind of result) give it an entry here and trigger it
// from diffFx() so nothing in the game is silent while the rest makes noise.
const FX = {
  deal: { tone: [[220, 0.05, 'triangle'], [330, 0.05, 'triangle'], [440, 0.09, 'triangle']], vib: [20] },
  flip: { tone: [[1150, 0.035, 'square', 0.03]], vib: [8] },
  discard: { tone: [[660, 0.08], [880, 0.14]], vib: [40, 60, 40] },           // your turn to discard
  pay: { tone: [[520, 0.08, 'triangle', 0.05]], vib: [] },                     // a board paid to someone else
  win: { tone: [[523, 0.09], [659, 0.09], [784, 0.18]], vib: [30, 40, 70] },   // you won a board
  pocket: { tone: [[392, 0.12, 'sawtooth', 0.05], [311, 0.12, 'sawtooth', 0.05], [233, 0.28, 'sawtooth', 0.05]], vib: [80, 50, 80] }, // the Pocket took a board
  done: { tone: [[440, 0.08], [554, 0.1]], vib: [] },                          // round finished
  yourDeal: { tone: [[587, 0.08], [740, 0.08], [880, 0.14]], vib: [30, 30, 30] }, // the deal passed to you
  end: { tone: [[523, 0.1], [659, 0.1], [784, 0.1], [1047, 0.3]], vib: [50, 50, 120] }, // game over, settle up
};
let actx = null;
function fx(name, times = 1) {
  const f = FX[name];
  if (!f || !prefs.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    for (let k = 0; k < times; k++) {
      let t = actx.currentTime + k * 0.07;
      for (const [freq, dur, type = 'sine', vol = 0.08] of f.tone) {
        const o = actx.createOscillator();
        const g = actx.createGain();
        o.type = type;
        o.frequency.value = freq;
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(actx.destination);
        o.start(t);
        o.stop(t + dur);
        t += dur * 0.9;
      }
    }
  } catch { /* no audio on this phone */ }
  try { if (f.vib.length && navigator.vibrate) navigator.vibrate(f.vib); } catch { /* no vibration */ }
}

// Works out what just happened by comparing the screen before and after.
function diffFx(prev, next) {
  if (!prev || !next) return;
  if (prev.phase !== 'ended' && next.phase === 'ended') { fx('end'); return; }
  if (next.dealerRotate && prev.control !== next.control && next.control === next.you) fx('yourDeal');
  const pg = prev.game;
  const ng = next.game;
  if (!ng || next.phase !== 'play') return;
  if (!pg || pg.no !== ng.no || prev.phase !== 'play') { fx('deal'); if (ng.needDiscard) fx('discard'); return; }
  if (ng.shown > pg.shown) fx('flip', Math.min(5, ng.shown - pg.shown));
  const before = pg.results ? pg.results.length : 0;
  const after = ng.results ? ng.results.length : 0;
  if (after > before && ng.stage === 'showdown') {
    const r = ng.results[after - 1];
    if (r.winners.some((w) => w.id === next.you)) fx('win');
    else if (r.winners.some((w) => w.id === CARRY_ID)) fx('pocket');
    else fx('pay');
  }
  if (pg.stage !== 'done' && ng.stage === 'done') fx('done');
  if (!pg.needDiscard && ng.needDiscard) fx('discard');
}

function setView(v) {
  const prev = view;
  view = v;
  diffFx(prev, v);
  render();
}

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
  const rank = c[0] === 'T' ? '10' : c[0];
  return `<div class="card s-${c[1]} ${cls}" ${attrs}><span class="r">${rank}</span><span class="s">${SUIT[c[1]]}</span></div>`;
}
const mini = (cards) => `<span class="mini">${cards.map((c) => cardHtml(c)).join('')}</span>`;
const balHtml = (c) => `<span class="bal ${c > 0 ? 'pos' : c < 0 ? 'neg' : ''}">${c > 0 ? '+' : ''}${money(c)}</span>`;
const signed = (c) => `${c > 0 ? '+' : ''}${money(c)}`;
const joinUrl = () => `${location.origin}${location.pathname}?room=${roomCode}`;
const hasPeer = () => typeof window.Peer === 'function';
const labelFor = (layout, i) => (layout === 'crossword' ? (i < 5 ? `${i + 1} Across` : `${i - 4} Down`) : `Board ${i + 1}`);
const nameOfPlayer = (id) => ((view && view.players.find((p) => p.id === id)) || { name: 'the host' }).name;

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

// A QR code for the join link, drawn on this phone (no outside service).
function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return '';
  try {
    const q = window.qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) path += `M${c + 2} ${r + 2}h1v1h-1z`;
    return `<svg class="qr" viewBox="0 0 ${n + 4} ${n + 4}" role="img" aria-label="QR code to join this room"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  } catch { return ''; }
}

// ---------- history kept on the host's phone ----------

let hist = ls.json('xw_hist2') || [];
let histCache = null;

function histExtra() {
  if (histCache) return histCache;
  const totals = new Map();
  for (const h of hist) {
    for (const p of h.players) {
      const k = p.name.toLowerCase();
      const t = totals.get(k) || { name: p.name, cents: 0, luck: 0, sessions: 0 };
      t.cents += p.cents; t.luck += p.luck || 0; t.sessions += 1; t.name = p.name;
      totals.set(k, t);
    }
  }
  const list = [...totals.values()].sort((a, b) => b.cents - a.cents);
  histCache = { past: hist.slice(-8).reverse(), totals: list, roster: list.map((t) => t.name) };
  return histCache;
}
function saveHist() { hist = hist.slice(-60); ls.set('xw_hist2', JSON.stringify(hist)); histCache = null; }

// Long-term stats only count rounds between people. Rounds against CPU players never count.
function recordSession() {
  const id = `${session.code}-${session.startedAt}`;
  if (hist.some((h) => h.id === id)) return;
  const totals = new Map();
  const get = (name) => { if (!totals.has(name)) totals.set(name, { name, cents: 0, luck: 0 }); return totals.get(name); };
  const rounds = session.log.filter((l) => l.online);
  if (!rounds.length) return;
  for (const l of rounds) {
    for (const n of l.net) if (!n.bot) get(n.name).cents += n.cents;
    for (const st of l.stats || []) if (!st.bot) get(st.name).luck += st.luck;
  }
  const last = session.log[session.log.length - 1];
  if (session.refund && session.refund.shares && last.online) {
    for (const n of session.refund.shares) if (!n.bot) get(n.name).cents += n.cents;
  }
  hist.push({ id, when: Date.now(), games: rounds.length, players: [...totals.values()] });
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
  setView(S.viewFor(session, session.hostId, online, extra));
}

function hostAct(result) {
  if (result && result.error) toast(result.error);
  commit();
}

// Things the person running the round may do (the host, or the dealer when the deal rotates).
function runCtl(a, x) {
  switch (a) {
    case 'rule': return S.setRules(session, x && typeof x === 'object' ? x : {});
    case 'deal': return S.deal(session, cryptoRnd);
    case 'next': return S.advance(session);
    case 'autoDiscard': return S.autoDiscardRest(session);
    case 'lobby': return S.toLobby(session);
    case 'step': return S.setOption(session, { stepReveal: !!x });
    default: return { error: 'Unknown action.' };
  }
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
      else if (m.t === 'ctl' && pid) r = S.canControl(session, pid) ? runCtl(String(m.a), m.x) : { error: "It isn't your deal." };
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
        net = { status: 'online', msg: '' };
        const me = m.view.players.find((x) => x.id === m.view.you);
        if (me && me.name !== myName) { myName = me.name; ls.set('xw_name', myName); }
        setView(m.view);
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
    if (role === 'host') for (const c of conns.values()) sendTo(c, { t: 'away' });
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
  copyLink();
}
async function copyLink() {
  const url = joinUrl();
  try { await navigator.clipboard.writeText(url); toast('Join link copied.'); }
  catch { window.prompt('Copy this join link:', url); }
}

const isHost = () => role === 'host';
// the round is run by the host, or by the dealer when the deal rotates
function ctl(a, x) {
  if (isHost()) hostAct(runCtl(a, x));
  else sendHost({ t: 'ctl', a, x });
}

const actions = {
  noop() {},
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
  logo() {
    if (!role) { location.href = location.pathname; return; }
    const msg = isHost()
      ? 'Go back to the start screen? Your room pauses for everyone until you come back and tap Resume.'
      : 'Go back to the start screen? You can rejoin with the room code and keep your seat.';
    if (!window.confirm(msg)) return;
    ls.del('xw_room');
    location.href = location.pathname;
  },
  // sheets: invite, how to play, settings
  sheet(name) { ui.sheet = name; render(); },
  closeSheet() { ui.sheet = null; render(); },
  share,
  copyLink,
  theme(t) { prefs.theme = t; applyPrefs(); render(); },
  pref(key, val) { prefs[key] = val === '1'; applyPrefs(); render(); if (key === 'sound' && prefs.sound) fx('win'); },
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
  // running the round (host, or the dealer when the deal rotates)
  rule(key, val) {
    let patch;
    if (key === 'variant') patch = { hole: parseInt(val, 10), free: val === '5f' };
    else if (key === 'layout' || key === 'discardTiming') patch = { [key]: val };
    else if (key === 'carryover' || key === 'showOdds') patch = { [key]: val === '1' };
    else patch = { [key]: Number(val) };
    ctl('rule', patch);
  },
  deal() { ui.sel = null; ui.board = null; ctl('deal'); },
  next() { ctl('next'); },
  autoDiscard() { ctl('autoDiscard'); },
  lobby() { ctl('lobby'); },
  step(on) { ctl('step', on === '1'); },
  // host only
  option(key, val) { if (isHost()) hostAct(S.setOption(session, { [key]: val === '1' })); },
  addBot() { if (isHost()) hostAct(S.addBot(session)); },
  kick(id) { if (isHost()) hostAct(S.removePlayer(session, id)); },
  makeHost(id) {
    if (!isHost()) return;
    const p = session.players.find((x) => x.id === id);
    if (p && window.confirm(`Make ${p.name} the host? Their phone will run the game from now on.`)) startHandover(id);
  },
  end() {
    if (!isHost() || !window.confirm('End the game and show the settle-up?')) return;
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
  if (e.target.id === 'stake') {
    const v = Math.round(parseFloat(e.target.value) * 100);
    if (Number.isFinite(v) && v >= 1) ctl('rule', { stakeCents: v });
    else { toast('Enter a stake above $0.'); render(); }
  }
});
$app.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.sheet) { actions.closeSheet(); return; }
  if (e.key !== 'Enter') return;
  if (e.target.id === 'code') actions.join();
  else if (e.target.id === 'name' && view && !view.you) actions.claimNew();
  else if (e.target.id === 'stake') e.target.blur();
});

// ---------- rendering ----------

function render() {
  let body;
  if (!view) body = `<div class="narrow">${renderHome()}</div>`;
  else {
    const host = view.hostId === view.you;
    const ctrl = host || view.control === view.you;
    if (view.phase === 'ended') body = `<div class="narrow">${renderEnded(host)}</div>`;
    else if (!view.you) body = `<div class="narrow">${renderPicker()}</div>`;
    else if (view.phase === 'lobby' || !view.game) body = renderLobby(host, ctrl);
    else body = renderTable(host, ctrl);
  }
  $app.innerHTML = renderHeader() + body + renderSheet();
}

function renderHeader() {
  const dot = net.status === 'online' ? 'on' : net.status === 'connecting' ? 'wait' : '';
  return `<header>
    <button class="brand" data-act="logo" aria-label="Crossword Slots: back to the start">Crossword <span>Slots</span></button>
    ${view ? `<button class="chip" data-act="sheet" data-a="invite"><b>${esc(view.code)}</b> · Invite</button>` : ''}
    <button class="ic" data-act="sheet" data-a="help" aria-label="How to play">?</button>
    <button class="ic" data-act="sheet" data-a="settings" aria-label="Settings">⚙</button>
    ${view ? `<span class="dot ${dot}"></span>` : ''}
  </header>${view && net.msg ? `<div class="netmsg">${esc(net.msg)}</div>` : ''}`;
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
  const resumable = saved && saved.v === S.SESSION_VERSION && saved.phase !== 'ended' && saved.hostDid === did;
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

// ---------- sheets: invite, how to play, settings ----------

function renderSheet() {
  if (!ui.sheet) return '';
  let title;
  let body;
  if (ui.sheet === 'invite' && view) {
    title = 'Invite friends';
    const qr = qrSvg(joinUrl());
    body = `<div class="center">
      ${qr ? `<div class="qrbox">${qr}</div><p class="muted small">Point a phone camera at this to join.</p>` : ''}
      <div class="bigcode">${esc(view.code)}</div>
      <p class="muted small" style="word-break:break-all">${esc(joinUrl())}</p></div>
      <div class="row"><button class="btn grow" data-act="share">Share link</button><button class="btn ghost grow" data-act="copyLink">Copy link</button></div>`;
  } else if (ui.sheet === 'settings') {
    title = 'This phone';
    body = `<div class="opt"><div class="lab"><span>Look</span><span class="muted small">trying out five; one will be kept</span></div>
        <div class="seg wrap">${THEMES.map(([id, name]) => `<button data-act="theme" data-a="${id}" class="${prefs.theme === id ? 'on' : ''}">${name}</button>`).join('')}</div></div>
      <div class="opt"><div class="lab"><span>Four-colour deck</span><span class="mini">${['As', 'Ah', 'Ad', 'Ac'].map((c) => cardHtml(c)).join('')}</span></div>
        <div class="seg">${[[0, 'Off'], [1, 'On']].map(([v, l]) => `<button data-act="pref" data-a="deck4" data-b="${v}" class="${Number(prefs.deck4) === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="opt"><div class="lab"><span>Sound and vibration</span></div>
        <div class="seg">${[[0, 'Off'], [1, 'On']].map(([v, l]) => `<button data-act="pref" data-a="sound" data-b="${v}" class="${Number(prefs.sound) === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <p class="muted small" style="margin:0">These only change this phone. Vibration works on Android; iPhones don't allow it in a browser.</p>`;
  } else {
    title = 'How to play';
    body = renderHelp();
  }
  return `<div class="sheet-bg" data-act="closeSheet"><div class="sheet" data-act="noop">
    <div class="sheet-h"><h2>${title}</h2><button class="x" data-act="closeSheet" aria-label="Close">✕</button></div>${body}</div></div>`;
}

// Explains the rules that are switched on right now, and what the switched-off ones would do.
function renderHelp() {
  const inRound = view && view.game && view.phase === 'play';
  const r = view ? (inRound ? view.game.rules : view.rules) : null;
  const item = (title, state, text, on = true) => `<div class="hi ${on ? '' : 'offi'}"><div class="hih"><b>${title}</b><span class="tag ${on ? 'gold' : ''}">${state}</span></div><p>${text}</p></div>`;
  const basics = `<p style="margin:0 0 10px">Everyone puts in the same stake. Boards of five cards are dealt face up in three steps: the flop (3 cards), the turn (1) and the river (1). The best five-card poker hand on each board wins that board's pot. There is no betting and no folding.</p>
    <p class="muted small" style="margin:0 0 12px">Hands, best to worst: straight flush, four of a kind, full house, flush, straight, three of a kind, two pair, pair, high card. Ties split the pot. Balances start at $0 and show how far up or down you are.</p>`;
  const variants = {
    holdem: "Two cards each. On every board you make your best five from your 2 cards and the board's 5, in any mix. You can even play the board alone.",
    omaha: 'Four cards each. On every board you must play exactly 2 of your cards with exactly 3 from the board.',
    pine: 'Five cards each, then everyone throws one away and plays the other four like Omaha: exactly 2 of yours with exactly 3 from the board.',
    any: 'Five cards each and you keep them all. On every board you play 0, 1 or 2 of your cards with 5, 4 or 3 from the board.',
  };
  if (!r) {
    return `${basics}${item("Hold'em", '2 cards', variants.holdem)}${item('Omaha', '4 cards', variants.omaha)}${item('Pineapple', '5 cards', variants.pine)}${item('Any', '5 cards', variants.any)}
      ${item('Slots', 'layout', 'Each row is its own board, up to 5 boards.')}${item('Crossword', 'layout', 'A 5 by 5 grid. Every row is a board and every column is a board: 10 boards, and each card counts for one of each. Costs double the stake.')}
      ${item('Carryover', 'option', 'An extra hand called the Pocket is dealt. If it wins a board, that pot carries to the same board next round.')}`;
  }
  const key = r.hole === 2 ? 'holdem' : r.hole === 4 ? 'omaha' : r.free ? 'any' : 'pine';
  const per = r.stakeCents * (r.layout === 'crossword' ? 2 : 1);
  const dealer = view.dealerRotate ? nameOfPlayer(view.control) : null;
  return `<p class="muted small" style="margin:0 0 10px">${inRound ? 'The rules of this round.' : 'The rules set for the next round.'}</p>${basics}
    ${item('Hole cards', variantName(r), variants[key])}
    ${key === 'pine' ? item('Discard', r.discardTiming === 'pre' ? 'Before the flop' : 'After the flop', r.discardTiming === 'pre' ? 'You throw one card away before any board cards are shown.' : 'You see every flop first, then throw one card away.') : ''}
    ${r.layout === 'crossword'
    ? item('Board layout', 'Crossword', 'A 5 by 5 grid. Every row is a board (1 to 5 Across) and every column is a board (1 to 5 Down): 10 boards. Each card counts for one row and one column.')
    : item('Board layout', `Slots × ${inRound ? view.game.rows : r.boards}`, 'Each row is its own board. Boards have nothing to do with each other. Switching to Crossword would also make every column a board.')}
    ${item('Stake', `${money(per)} each`, `Base stake ${money(r.stakeCents)}${r.layout === 'crossword' ? ', doubled for Crossword' : ''}. Everything goes in the middle and is split evenly across the boards. Odd cents go to the lowest-numbered boards.`)}
    ${r.carryover
    ? item('Carryover', 'On', "An extra hand called the Pocket is dealt from the cards left in the deck (up to 5). Nobody plays it. If the Pocket has the best hand on a board, nobody gets that pot: it carries over to the same board next round, on top of the new pot. If it ties, only its share carries. Rules stay locked until carried money has been won.")
    : item('Carryover', 'Off', 'No Pocket hand. Every board is won by a player every round. If it were on, an extra hand nobody plays could win boards and carry those pots into the next round.', false)}
    ${view.oddsOn
    ? item('Win %', 'On', "The number under each board is your chance of winning it right now, worked out from everyone's real cards. Tap a board's number for everyone's chances, your best hand, and the cards you need.")
    : item('Win %', 'Off', "Percentages are hidden this game. Tapping a board's number still shows your best hand and the cards you need. If it were on, you would see everyone's chance on every board.", false)}
    ${view.dealerRotate
    ? item('Who deals', 'Passes around', `The deal moves to the next person after every round. The dealer picks Play again or New rules and taps to reveal. Right now it is ${esc(dealer)}'s deal.`)
    : item('Who deals', 'Host', 'The host deals every round and picks the rules. If "passes around" were on, each player would take a turn dealing and choosing the game.', false)}
    ${item('Revealing', view.stepReveal ? 'One by one' : 'All at once', 'Nothing moves on a timer. The dealer taps to reveal: "All at once" shows a whole step on every board, "One by one" shows one board per tap. At the showdown each board is paid on its own tap.')}`;
}

// ---------- lobby ----------

function seg(key, cur, options, disabled, act = 'rule') {
  return `<div class="seg">${options.map(([val, label, sub]) => `<button data-act="${act}" data-a="${key}" data-b="${val}" class="${String(cur) === String(val) ? 'on' : ''}" ${disabled ? 'disabled' : ''}>${label}${sub ? `<small>${sub}</small>` : ''}</button>`).join('')}</div>`;
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
      <span class="nm">${esc(p.name)}${p.id === view.you ? '<span class="tag gold">You</span>' : ''}${p.id === view.hostId ? '<span class="tag">Host</span>' : ''}${view.dealerRotate && p.id === view.control ? '<span class="tag gold">Dealer</span>' : ''}${p.bot ? '<span class="tag">CPU</span>' : ''}${!p.active ? '<span class="tag">Left</span>' : !p.online ? '<span class="tag">Offline</span>' : ''}${p.active && p.sitOut ? '<span class="tag">Sitting out</span>' : p.active && view.game && view.phase === 'play' && !p.inGame ? '<span class="tag">Next round</span>' : ''}${p.waiting ? '<span class="tag gold">Discarding</span>' : ''}</span>
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
  const chips = (list, luck) => list.map((n) => `<span class="hc ${n.cents > 0 ? 'pos' : n.cents < 0 ? 'neg' : ''}">${esc(n.name)} ${signed(n.cents)}${luck && n.luck ? ` <span class="muted">(luck ${signed(n.luck)})</span>` : ''}</span>`).join('');
  if (!view.log.length && !view.past.length) return '';
  return `<details class="panel hist"><summary>History</summary>
    ${view.log.length ? `<h3>This game</h3>${view.log.slice().reverse().map((l) => `<div class="hrow"><div class="muted small">Round ${l.no} · ${esc(l.line)}${l.carried ? ` · <span class="co">${money(l.carried)} carried</span>` : ''}</div><div>${chips(l.net)}</div></div>`).join('')}` : ''}
    ${view.totals.length ? `<h3>All-time on the host's phone</h3><div class="hrow">${chips(view.totals, true)}</div><p class="muted small" style="margin:4px 0 0">Luck is what someone won compared with what their starting cards were worth. Only rounds between people count.</p>` : ''}
    ${view.past.length ? `<h3>Past games</h3>${view.past.map((h) => `<div class="hrow"><div class="muted small">${d(h.when)} · ${h.games} round${h.games === 1 ? '' : 's'}</div><div>${chips(h.players, true)}</div></div>`).join('')}` : ''}
  </details>`;
}

function renderLobby(host, ctrl) {
  const r = view.rules;
  const lock = view.locked;
  const dis = !ctrl || lock;
  const nIn = view.players.filter((p) => p.active && !p.sitOut).length;
  const roundNo = (view.log.length ? view.log[view.log.length - 1].no : 0) + 1;
  const rules = ctrl
    ? `${lock ? '<div class="lock">🔒 Rules are locked until the carryover pot has been played out.</div>' : ''}
      <div class="opt"><div class="lab"><span>Hole cards</span></div>${seg('variant', r.hole === 5 && r.free ? '5f' : r.hole, [[2, '2', "Hold'em"], [4, '4', 'Omaha'], [5, '5', 'Pineapple'], ['5f', '5', 'Any (keep all)']], dis)}</div>
      ${r.hole === 5 && !r.free ? `<div class="opt"><div class="lab"><span>Discard one card</span></div>${seg('discardTiming', r.discardTiming, [['pre', 'Before the flop'], ['post', 'After the flop']], dis)}</div>` : ''}
      ${r.hole === 5 && r.free ? '<p class="muted small" style="margin:-4px 0 10px">Keep all five. Each board plays your best hand using 0, 1 or 2 of them.</p>' : ''}
      <div class="opt"><div class="lab"><span>Board layout</span></div>${seg('layout', r.layout, [['slots', 'Slots', 'rows only'], ['crossword', 'Crossword', '5 across + 5 down']], dis)}</div>
      ${r.layout === 'slots' ? `<div class="opt"><div class="lab"><span>Boards</span></div>${seg('boards', r.boards, [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']], dis)}</div>` : ''}
      <div class="opt"><div class="lab"><span>Carryover (the Pocket)</span></div>${seg('carryover', r.carryover ? 1 : 0, [[0, 'Off'], [1, 'On']], dis)}</div>
      <div class="opt"><div class="lab"><span>Show win %</span>${!r.showOdds && view.oddsOn ? '<span class="muted small">always on vs CPUs</span>' : ''}</div>${seg('showOdds', r.showOdds ? 1 : 0, [[0, 'Off'], [1, 'On']], false)}</div>
      ${host ? `<div class="opt"><div class="lab"><span>Who deals</span></div>${seg('dealerRotate', view.dealerRotate ? 1 : 0, [[0, 'Host', 'every round'], [1, 'Passes around', 'dealer picks the rules']], false, 'option')}</div>` : ''}
      <div class="opt row"><div class="grow">Base stake per player</div><div class="stake">$<input class="text" id="stake" type="number" inputmode="decimal" min="0.01" step="0.01" value="${(r.stakeCents / 100).toFixed(2)}" ${dis ? 'disabled' : ''}></div></div>`
    : `<p style="margin:0 0 8px"><b>${esc(rulesLine(r))}</b><br><span class="muted">Base stake ${money(r.stakeCents)} per player · win % ${view.oddsOn ? 'on' : 'off'}</span></p>`;
  const bar = [];
  if (ctrl) bar.push(`<button class="btn" data-act="deal" ${view.plan.ok ? '' : 'disabled'}>Deal round ${roundNo}</button>`);
  if (host) bar.push('<button class="btn danger sm" style="width:100%" data-act="end">End game and settle up</button>');
  return `<div class="cols"><div class="col-l">
    <div class="panel"><h2>Players (${nIn} in)</h2>${renderPlayers(host, true)}
      ${renderSelf(host)}
      ${host ? '<div class="row mt"><button class="btn ghost sm grow" data-act="addBot">+ Add CPU player</button><button class="btn ghost sm grow" data-act="sheet" data-a="invite">Invite friends</button></div>' : ''}
    </div>
    ${bar.length ? `<div class="bar"><div class="in">${bar.join('')}</div></div>` : ''}
    </div><div class="col-r">
    <div class="panel"><h2>Rules for the next round <button class="link" data-act="sheet" data-a="help">What do these mean?</button></h2>${rules}${renderPlan()}
      <p class="muted small" style="margin:8px 0 0">Rounding: everything is counted in cents. If a pot doesn't split evenly, the extra cents go to the lowest-numbered boards, and on a tied board to the tied players in seat order (the Pocket last).</p>
    </div>
    ${renderHistory()}
    ${ctrl ? '' : `<p class="status">Waiting for ${esc(nameOfPlayer(view.control))} to deal…</p>`}
    ${host ? '' : '<button class="btn ghost" data-act="leave">Leave room</button>'}
    </div></div>`;
}

// ---------- the table ----------

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
  if (carry && !real.length) return `The Pocket wins. <span class="co">${money(carry.cents)} carries to ${esc(res.label)} next round.</span>`;
  const names = real.map((w) => `${esc(w.name)} ${real.length > 1 || carry ? money(w.cents) : ''}`.trim()).join(', ');
  if (carry) return `Split: ${names}. <span class="co">The Pocket's ${money(carry.cents)} carries over.</span>`;
  return real.length > 1 ? `Split: ${names}` : `${names} wins ${money(real[0].cents)}`;
}

// A player's whole hand and the whole board, with the cards that aren't being played dimmed.
function usedHtml(hole, board, used) {
  const u = new Set(used);
  const one = (c) => cardHtml(c, u.has(c) ? '' : 'un');
  return `<span class="mini sm">${hole.map(one).join('')}<span class="sep"></span>${board.map(one).join('')}</span>`;
}
function boardCardsOf(g, i) {
  const inBoard = boardCells(g, i);
  const board = [];
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < 5; c++) if (inBoard(r, c) && g.grid[r][c]) board.push(g.grid[r][c]);
  return board;
}
const holeOf = (g, id) => ((g.hands || []).find((h) => h.id === id) || { cards: [] }).cards;

let outCache = { key: '', val: null };
function myOutlook(g, i) {
  if (!g.myHole) return null;
  const key = [view.code, g.no, i, g.shown, g.myDiscard].join('|');
  if (outCache.key === key) return outCache.val;
  const board = boardCardsOf(g, i);
  let val = { empty: true };
  if (board.length >= 3) {
    const hole = g.myDiscard === null ? g.myHole : g.myHole.filter((_, k) => k !== g.myDiscard);
    const seen = new Set([...g.myHole, ...g.grid.flat().filter(Boolean)]);
    val = outlook(hole, board, makeDeck().filter((c) => !seen.has(c)), playMode(g.rules)) || { empty: true };
    val.hole = hole;
    val.board = board;
  }
  outCache = { key, val };
  return val;
}

function renderOutlook(g, i) {
  const o = myOutlook(g, i);
  if (!o) return '';
  if (o.empty) return '<p class="muted" style="margin:0 0 8px">Fewer than three cards on this board so far.</p>';
  const flip = o.toCome === 2 ? 'on the next card' : 'on the last card';
  // most likely first
  const rows = o.rows.slice().sort((p, q) => (q.final ?? q.next) - (p.final ?? p.next)).map((r) => {
    const bits = [];
    if (r.cards.length) bits.push(`${r.cards.length} card${r.cards.length === 1 ? '' : 's'} · ${pct(r.next)} ${flip}`);
    else bits.push('needs both cards to come');
    if (r.final !== null) bits.push(`${pct(r.final)} by the river`);
    const shown = r.cards.slice(0, 7);
    return `<div class="lk"><div class="lkh"><b>${r.label}</b><span class="muted small">${bits.join(' · ')}</span></div>
      ${shown.length ? `<div class="lkc">${mini(shown)}${r.cards.length > shown.length ? `<span class="muted small"> +${r.cards.length - shown.length} more</span>` : ''}</div>` : ''}</div>`;
  }).join('');
  return `<div class="mine"><div class="lkh"><span><span class="muted small">YOUR HAND</span><br><b>${esc(o.name)}</b></span></div>
    <div class="lkc">${usedHtml(o.hole, o.board, o.cards)}</div>
    ${o.toCome ? (rows ? `<div class="muted small lkt">WHAT YOU'RE LOOKING FOR</div>${rows}` : '<p class="muted small" style="margin:6px 0 0">No single card turns this into a better kind of hand.</p>') : ''}</div>`;
}

const who = (x) => `${esc(x.name)}${x.id === view.you ? '<span class="tag gold">You</span>' : ''}`;

function renderBoardDetail(g) {
  const i = ui.board;
  if (i === null) return '';
  const res = g.results ? g.results.find((r) => r.index === i) : null;
  const odds = g.odds && g.odds.boards[i];
  let body;
  const mine = res ? '' : renderOutlook(g, i);
  if (res) {
    const won = new Map(res.winners.map((w) => [w.id, w.cents]));
    body = `<ul class="plist">${res.all.map((x) => `<li class="col ${won.has(x.id) ? 'winner' : ''}"><span class="nm">${who(x)} <span class="muted small">· ${esc(x.handName)}${won.has(x.id) ? ` · <span class="co">${x.id === CARRY_ID ? 'carries' : 'wins'} ${money(won.get(x.id))}</span>` : ''}</span></span>${usedHtml(holeOf(g, x.id), boardCardsOf(g, i), x.cards)}</li>`).join('')}</ul>`;
  } else if (odds) {
    body = odds.map((x) => `<div class="orow ${x.id === CARRY_ID ? 'pk' : ''}"><span class="nm">${who(x)}</span><span class="track"><i style="width:${Math.round(x.share * 100)}%"></i></span><b>${pct(x.share)}</b></div>`).join('')
      + '<p class="muted small" style="margin:8px 0 0">Chance of winning this board right now. A split counts as a share.</p>';
  } else {
    body = `<p class="muted small" style="margin:0">${g.oddsWait ? 'Win % appears once everyone has discarded.' : g.hands ? 'This board has not been paid yet.' : 'Win % is turned off for this game.'}</p>`;
  }
  return `<div class="panel detail"><h2>${esc(g.labels[i])} · ${money(g.pots[i])} pot${g.carryIn[i] ? ` <span class="co">(${money(g.carryIn[i])} carried in)</span>` : ''}</h2>${mine}${body}</div>`;
}

function renderEV(g) {
  if (!g.odds || !g.odds.ev) return '';
  return `<div class="panel"><h2>Expected winnings right now</h2>
    ${g.odds.ev.map((x) => `<div class="orow ${x.id === CARRY_ID ? 'pk' : ''}"><span class="nm">${who(x)}</span><span class="track"><i style="width:${Math.round(x.share * 100)}%"></i></span><b>${money(x.cents)}</b></div>`).join('')}
    <p class="muted small" style="margin:8px 0 0">Each board's pot times the chance of winning it, added up. Everyone put in ${money(g.perPlayer)}.${g.odds.ev.some((x) => x.id === CARRY_ID) ? " The Pocket's share would carry over." : ''}</p></div>`;
}

function renderMyHand(g) {
  if (!g.myHole) return `<p class="status">${view.sitOut ? "You're sitting out and watching." : "You'll be dealt in next round."}</p>`;
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

function renderTable(host, ctrl) {
  const g = view.game;
  const grid = renderGrid(g);
  const paying = g.stage === 'showdown' ? g.results[g.results.length - 1] : null;
  const waiting = g.waitingOn.length;
  const runner = esc(nameOfPlayer(view.control));
  let mid = '';
  if (paying) {
    mid = `<div class="banner"><div class="t">${esc(paying.label)} · ${money(paying.pot)} pot</div>
      <div class="w">${winnersText(paying)}</div>
      <div class="h">${esc(paying.handName)}</div>
      ${paying.winners.map((w) => `<div class="bw">${paying.winners.length > 1 ? `<span class="muted small">${esc(w.name)}</span>` : ''}${usedHtml(holeOf(g, w.id), boardCardsOf(g, paying.index), w.cards)}</div>`).join('')}</div>`;
  } else if (g.stage !== 'done') {
    const line = waiting ? `Waiting for ${esc(g.waitingOn.join(', '))} to discard…` : ctrl ? '' : `Waiting for ${runner} to ${g.next ? `reveal the ${g.next.street}` : 'start the showdown'}…`;
    if (line) mid = `<p class="status">${line}</p>`;
  } else if (!ctrl) {
    mid = `<p class="status">Waiting for ${runner} to deal the next round…</p>`;
  }
  const hint = ui.board === null && g.shown > 0 && (g.odds || g.results || g.myHole)
    ? `<p class="hint">Tap a board's number to see ${g.results ? 'every hand on it' : g.odds ? "your hand, what you're looking for, and everyone's chances" : "your hand and what you're looking for"}.</p>` : '';
  let lower = '';
  if (g.hands) {
    const winIds = new Set(paying ? paying.winners.map((w) => w.id) : []);
    lower += `<div class="panel"><h2>Hands</h2><ul class="plist hands">${g.hands.map((h) => `<li class="${winIds.has(h.id) ? 'winner' : ''}">
      <span class="nm">${who(h)}</span>${mini(h.cards)}</li>`).join('')}</ul></div>`;
  }
  if (g.stage === 'done') {
    const carried = view.carry.reduce((a, b) => a + b, 0);
    const anyPre = g.results.some((r) => r.winners.some((w) => w.pre !== null));
    lower = `<div class="panel"><h2>Round ${g.no} results</h2><table class="sum">${g.results.map((r) => `<tr data-act="board" data-a="${r.index}"><td><b>${esc(r.label)}</b></td>
        <td>${r.winners.map((w) => `${w.id === CARRY_ID ? '<span class="co">The Pocket</span>' : esc(w.name)}${w.pre !== null ? ` <span class="pre">${pct(w.pre)}</span>` : ''}`).join(', ')}<br><span class="muted small">${esc(r.handName)}</span></td>
        <td>${money(r.pot)}</td></tr>`).join('')}</table>
        ${anyPre ? '<p class="muted small" style="margin:8px 0 0">The % is the chance that hand had on a board before any board card was dealt.</p>' : ''}</div>
      <div class="panel"><h2>This round</h2><ul class="plist">${g.net.map((n) => `<li><span class="nm">${esc(n.name)}${n.pre !== null ? ` <span class="pre">${pct(n.pre)} a board</span>` : ''}<br><span class="muted small">luck ${signed(n.luck)}</span></span>${balHtml(n.cents)}</li>`).join('')}</ul>
      <p class="muted small" style="margin:8px 0 0">Luck is what you won compared with what your starting cards were worth on average.</p>
      ${carried ? `<p class="co small" style="margin:8px 0 0">${money(carried)} carries over to the next round. Rules stay locked until it is won.</p>` : ''}</div>` + lower;
  }
  let bar = '';
  if (ctrl) {
    if (g.stage === 'done') {
      bar = `${view.plan.ok ? '<button class="btn" data-act="deal">Play again, same rules</button>' : `<div class="plan no"><p>${esc(view.plan.reason)}</p></div>`}
        <div class="two"><button class="btn ghost sm" data-act="lobby">${view.locked ? 'Players and rules' : 'New rules'}</button>${host ? '<button class="btn danger sm" data-act="end">End game</button>' : ''}</div>`;
    } else if (waiting) {
      bar = `<button class="btn ghost" data-act="autoDiscard">Auto-discard for ${waiting} slow player${waiting === 1 ? '' : 's'}</button>`;
    } else if (g.stage === 'showdown') {
      bar = `<button class="btn" data-act="next">${g.payIndex < g.nBoards ? `Pay ${esc(g.labels[g.payIndex])} ▸` : 'Finish the round'}</button>`;
    } else {
      const street = g.next ? g.next.street : null;
      const cap = street ? street[0].toUpperCase() + street.slice(1) : '';
      const label = !street ? 'Showdown'
        : view.stepReveal ? `${cap} · ${esc(g.labels[g.next.board])}`
          : `${g.next.started ? 'Finish' : 'Reveal'} the ${street}`;
      bar = `<div class="two"><button class="btn" data-act="next" style="flex:1">${label}</button>
        ${street ? `<button class="btn ghost sm tog" data-act="step" data-a="${view.stepReveal ? 0 : 1}" aria-label="Switch between revealing every board at once and one board per tap">${view.stepReveal ? 'One by one' : 'All at once'}<small>tap to switch</small></button>` : ''}</div>`;
    }
  }
  return `<div class="cols"><div class="col-l">
    <div class="info">Round ${g.no} · <b>${esc(rulesLine(g.rules, g.rows))}</b> · ${money(g.perPlayer)} in each <button class="link" data-act="sheet" data-a="help">Rules</button></div>
    ${grid}
    ${hint}
    ${bar ? `<div class="bar"><div class="in">${bar}</div></div>` : ''}
    </div><div class="col-r">
    ${mid}
    ${renderBoardDetail(g)}
    <div class="myhand">${renderMyHand(g)}</div>
    ${renderEV(g)}
    ${lower}
    <div class="panel"><h2>Balances</h2>${renderPlayers(host, false)}${renderSelf(host)}</div>
    </div></div>`;
}

function renderEnded(host) {
  const sorted = view.players.slice().sort((a, b) => b.balance - a.balance);
  return `
    <div class="hero" style="padding-top:8px"><h1>Settle <span>up</span></h1><p>The game is over. Chips are play money: settle between yourselves.</p></div>
    <div class="panel"><h2>Who pays who</h2>
      ${view.settle && view.settle.length
    ? `<ul class="plist settle">${view.settle.map((t) => `<li><span class="nm"><b>${esc(t.from)}</b><span class="arrow">pays</span><b>${esc(t.to)}</b></span><span class="bal">${money(t.cents)}</span></li>`).join('')}</ul>`
    : '<p class="muted" style="margin:0">Everyone is even. Nobody owes anything.</p>'}
    </div>
    <div class="panel"><h2>Final balances</h2><ul class="plist">${sorted.map((p) => `<li><span class="nm">${esc(p.name)}${p.id === view.you ? '<span class="tag gold">You</span>' : ''}</span>${balHtml(p.balance)}</li>`).join('')}</ul>
      ${view.refund ? `<p class="co small" style="margin:8px 0 0">${money(view.refund.total)} of unclaimed carryover was split evenly between the ${view.refund.count} players of the last round.</p>` : ''}
    </div>
    ${view.awards && view.awards.length ? `<div class="panel"><h2>Awards</h2><ul class="plist">${view.awards.map((a) => `<li><span class="nm"><span class="muted small">${esc(a.title.toUpperCase())}</span><br><b>${esc(a.name)}</b> <span class="muted small">· ${esc(a.detail)}</span></span></li>`).join('')}</ul></div>` : ''}
    ${renderHistory()}
    <button class="btn ${host ? '' : 'ghost'}" data-act="${host ? 'fresh' : 'home'}">${host ? 'Start a new game' : 'Back to start'}</button>`;
}

// ---------- boot ----------

(function boot() {
  const saved = ls.json('xw_host');
  const mine = saved && saved.v === S.SESSION_VERSION && saved.hostDid === did;
  if (saved && saved.v !== S.SESSION_VERSION) ls.del('xw_host'); // from an older version of the game
  if (urlRoom && mine && saved.code === urlRoom) {
    session = saved;
    startHost(false);
  } else if (urlRoom) {
    startClient(urlRoom);
  } else {
    render();
  }
})();
