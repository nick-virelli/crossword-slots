// Crossword Slots — the moving paint-swirl background of the Pixel look.
// Drawn at a very low resolution on a canvas and stretched with hard pixels, a few frames a
// second. It only runs while the Pixel look is on and the page is visible.

const PX_PHONE = 4;    // size of one background pixel on a phone, in CSS pixels
const PX_DESK = 6;
const FPS = 14;
const LEVELS = 9;      // colour steps per band, for the posterised look

// Each scene is a strip of colour stops across the swirl value (0 to 1).
const SCENES = {
  home: [[0, '#0a3f9a'], [0.2, '#0b7be6'], [0.36, '#6fc3ff'], [0.43, '#12224a'], [0.5, '#0d1430'], [0.57, '#3a1220'], [0.64, '#ff9a8f'], [0.8, '#f0453c'], [1, '#8f1820']],
  table: [[0, '#17503c'], [0.25, '#2b7a5a'], [0.42, '#49a57c'], [0.5, '#2f7f5e'], [0.62, '#216549'], [0.8, '#2d7d5c'], [1, '#144634']],
};

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function buildLut(stops) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    // snap to a few steps so the colours band like pixel art
    const v = Math.round((i / 255) * LEVELS * stops.length) / (LEVELS * stops.length);
    let k = 0;
    while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const [a, ca] = stops[k];
    const [b, cb] = stops[k + 1];
    const f = Math.max(0, Math.min(1, (v - a) / (b - a)));
    const A = hex(ca);
    const B = hex(cb);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = A[c] + (B[c] - A[c]) * f;
  }
  return lut;
}
const LUTS = { home: buildLut(SCENES.home), table: buildLut(SCENES.table) };

let canvas = null;
let ctx = null;
let img = null;
let timer = null;
let w = 0;
let h = 0;
const t0 = Date.now();

function size() {
  const px = innerWidth >= 900 ? PX_DESK : PX_PHONE;
  w = Math.max(40, Math.ceil(innerWidth / px));
  h = Math.max(40, Math.ceil(innerHeight / px));
  canvas.width = w;
  canvas.height = h;
  img = ctx.createImageData(w, h);
}

function frame() {
  const scene = document.documentElement.dataset.scene === 'table' ? 'table' : 'home';
  const lut = LUTS[scene];
  const t = (Date.now() - t0) / 1000;
  const L = Math.hypot(w, h);
  const d = img.data;
  const twist = scene === 'home' ? 7 : 4;
  let o = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let x = (i - w / 2) / L;
      let y = (j - h / 2) / L;
      // wind the picture around the middle, tighter toward the centre
      const r = Math.hypot(x, y);
      const a = Math.atan2(y, x) + t * 0.06 - twist * r + 1.5 / (r * 6 + 0.6);
      x = r * Math.cos(a) * 26;
      y = r * Math.sin(a) * 26;
      // push it around like wet paint
      for (let k = 0; k < 4; k++) {
        const nx = x + 1.25 * Math.sin(y * 0.55 + t * 0.31 + k * 1.7);
        y += 1.25 * Math.cos(x * 0.55 - t * 0.23 + k * 2.3);
        x = nx;
      }
      const v = (Math.sin(x * 0.33 + y * 0.21) + 0.5 * Math.sin(y * 0.47 - x * 0.12 + t * 0.2)) / 3 + 0.5;
      const q = (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0) * 3;
      d[o++] = lut[q];
      d[o++] = lut[q + 1];
      d[o++] = lut[q + 2];
      d[o++] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Call whenever the look or the screen changes. Starts or stops the animation as needed.
export function syncBg() {
  const on = document.documentElement.dataset.theme === 'pixel';
  if (!canvas) {
    if (!on) return;
    canvas = document.getElementById('bgfx');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    addEventListener('resize', () => { if (ctx && document.documentElement.dataset.theme === 'pixel') { size(); frame(); } });
    document.addEventListener('visibilitychange', syncBg);
  }
  if (!on || document.hidden) { stop(); return; }
  if (!img) size();
  frame();
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!timer && !still) timer = setInterval(frame, 1000 / FPS);
}
