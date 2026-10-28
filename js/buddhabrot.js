/*
  Buddhabrot
  https://evoluteur.github.io/buddhabrot/
  (c) 2026 Olivier Giulieri

  Random points c of the plane are iterated with z -> z² + c. The orbits of
  the points that escape (or, for the Anti-Buddhabrot, of those that never
  do) are counted in every pixel they pass through, by several Web Workers
  at once, and the counts are shown like a long-exposure photograph.
*/

const BB = {
  size: 800, // histogram resolution
  hist: null, // one Uint32Array per channel (1, or 3 for the Nebulabrot)
  workers: [],
  gen: 0, // bumped at every restart, so late messages from old workers are ignored
  running: true,
  settled: false,
  samples: 0,
  orbits: 0,
  points: 0,
  img: null,
  dirty: false,
  raf: 0,
  lastRender: 0,
  progress: 0,
  t0: 0,
};

// the part of the plane that is drawn (the Buddhabrot fits in it)
const BB_VIEW = { re: -0.6, span: 2.95 };
// the starting points c are taken in the disk of radius 2, where the whole
// Mandelbrot set lies: any point further out escapes at the first step

const BB_ITERS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
const BB_MINS = [0, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

const BB_KINDS = {
  Buddhabrot: {
    escape: true,
    rgb: false,
    note: "The orbits of the points that escape, drawn as a long exposure: a seated Buddha with a halo.",
  },
  Nebulabrot: {
    escape: true,
    rgb: true,
    note: "Three Buddhabrots at once: short orbits in blue, medium in green, long in red, like a Hubble photograph of a nebula.",
  },
  "Anti-Buddhabrot": {
    escape: false,
    rgb: false,
    note: "The orbits of the points that never escape, the Mandelbrot set itself: they settle into loops and rings.",
  },
};

const BB_PALETTES = {
  Gold: { bg: [6, 4, 2], stops: ["#060402", "#3d2a0c", "#a87a2a", "#f1cf7a", "#fffbec"] },
  Ghost: { bg: [3, 4, 10], stops: ["#03040a", "#232a46", "#7c88b8", "#d6dcf5", "#ffffff"] },
  Ember: { bg: [8, 4, 2], stops: ["#0a0402", "#7a1c00", "#e2560b", "#ffb347", "#fff4d6"] },
  Lotus: { bg: [8, 3, 10], stops: ["#08030a", "#4a1240", "#b8337a", "#f6a6c1", "#fff2f6"] },
  Jade: { bg: [2, 7, 6], stops: ["#02070a", "#0d3b33", "#2a9d7c", "#a8f0c8", "#f4fff8"] },
  Ice: { bg: [2, 6, 14], stops: ["#020617", "#0c4a6e", "#0ea5e9", "#a5f3fc", "#ffffff"] },
  "Ink on paper": { bg: [246, 241, 231], stops: ["#f6f1e7", "#c2b69f", "#6b604f", "#262019", "#000000"] },
};

// "Next preset" goes through these
const BB_PRESETS = [
  { kind: "Buddhabrot", max: 1000, min: 20, palette: "Gold", exposure: 1, contrast: 0.6 },
  { kind: "Nebulabrot", r: 5000, g: 500, b: 50, min: 10, exposure: 1, contrast: 0.6 },
  { kind: "Buddhabrot", max: 100, min: 10, palette: "Ghost", exposure: 1, contrast: 0.8 },
  { kind: "Anti-Buddhabrot", max: 500, min: 0, palette: "Lotus", exposure: 1, contrast: 0.45 },
  { kind: "Buddhabrot", max: 200, min: 10, palette: "Ink on paper", exposure: 1, contrast: 0.55 },
  { kind: "Nebulabrot", r: 2000, g: 200, b: 20, min: 5, exposure: 1.2, contrast: 0.55 },
  { kind: "Buddhabrot", max: 5000, min: 500, palette: "Jade", exposure: 1, contrast: 0.5 },
];

// the picture is settled when its bright parts got this many points per pixel:
// the grain left (about 1/√n) is too fine to see
const BB_SETTLE = 2500;
const BB_ANTI_ORBITS = 8; // orbits per pixel

const bbEl = (id) => document.getElementById(id);
const bbKind = () => BB_KINDS[bbEl("bb-kind").value];
const bbIter = (id) => BB_ITERS[+bbEl(id).value];
const bbSeated = () => bbEl("bb-orient").value === "seated";

// ------------------------------------------------------------ the workers

// The worker's code, run from a Blob so the page also works from a file.
// It sends the pixels hit as a list of numbers (pixel index × 8 + one bit per
// channel), in buffers that the page sends back once added up.
function bbWorkerCode() {
  let P = null;
  let ore;
  let oim;
  const pool = [];
  let waiting = false;

  onmessage = (e) => {
    const m = e.data;
    if (m.type === "start") {
      P = m;
      ore = new Float64Array(P.max + 1);
      oim = new Float64Array(P.max + 1);
      for (let i = 0; i < 3; i++) pool.push(new Uint32Array(1 << 20));
      work();
    } else if (m.type === "buf") {
      pool.push(new Uint32Array(m.buf));
      if (waiting) {
        waiting = false;
        work();
      }
    }
  };

  function work() {
    if (!pool.length) {
      waiting = true;
      return;
    }
    const buf = pool.pop();
    const { N, x0, y0, span, seated, escape, lims, min, max } = P;
    const k = N / span;
    const nl = lims.length;
    const room = buf.length - 2 * max - 4;
    const t0 = performance.now();
    let n = 0;
    let orbits = 0;
    let samples = 0;
    while (n < room && performance.now() - t0 < 60) {
      for (let s = 0; s < 500 && n < room; s++) {
        samples++;
        const cr = Math.random() * 4 - 2;
        const ci = Math.random() * 2; // the other half is the mirror image
        if (cr * cr + ci * ci > 4) continue;
        if (escape) {
          // the main cardioid and the big disk never escape: skip them
          const q = (cr - 0.25) * (cr - 0.25) + ci * ci;
          if (q * (q + (cr - 0.25)) < 0.25 * ci * ci) continue;
          if ((cr + 1) * (cr + 1) + ci * ci < 0.0625) continue;
        }
        let zr = 0;
        let zi = 0;
        let i = 0;
        for (; i < max; i++) {
          const zr2 = zr * zr;
          const zi2 = zi * zi;
          if (zr2 + zi2 > 4) break;
          zi = 2 * zr * zi + ci;
          zr = zr2 - zi2 + cr;
          ore[i] = zr;
          oim[i] = zi;
        }
        const escaped = i < max;
        let mask = 1;
        if (escape) {
          if (!escaped || i < min) continue;
          mask = 0;
          for (let c = 0; c < nl; c++) if (i <= lims[c]) mask |= 1 << c;
          if (!mask) continue;
        } else if (escaped) continue;
        orbits++;
        // the first point is c itself, where the orbit starts (drawing it would
        // only show where the points were taken), and the last point of an
        // escaping orbit is already outside: neither is drawn
        const last = escaped ? i - 1 : i;
        for (let j = 1; j < last; j++) {
          const re = ore[j];
          const im = oim[j];
          let fx, fy, gx, gy;
          if (seated) {
            // the real axis runs down the page: the head on top
            fy = (re - y0) * k;
            gy = fy;
            fx = (im - x0) * k;
            gx = (-im - x0) * k;
          } else {
            fx = (re - x0) * k;
            gx = fx;
            fy = (-im - y0) * k;
            gy = (im - y0) * k;
          }
          // the point and its mirror image across the real axis
          if (fy >= 0 && fy < N && fx >= 0 && fx < N) buf[n++] = ((fy | 0) * N + (fx | 0)) * 8 + mask;
          if (gy >= 0 && gy < N && gx >= 0 && gx < N) buf[n++] = ((gy | 0) * N + (gx | 0)) * 8 + mask;
        }
      }
    }
    postMessage({ type: "hits", buf: buf.buffer, n, orbits, samples }, [buf.buffer]);
    setTimeout(work, 0);
  }
}
const BB_WORKER_URL = URL.createObjectURL(
  new Blob([`(${bbWorkerCode.toString()})()`], { type: "text/javascript" }),
);

const bbWorkerCount = () => Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

const bbStopWorkers = () => {
  BB.workers.forEach((w) => w.terminate());
  BB.workers = [];
};

// the settings sent to the workers
const bbJob = () => {
  const K = bbKind();
  const N = BB.size;
  const lims = K.rgb ? ["r", "g", "b"].map((c) => bbIter("bb-" + c)) : [bbIter("bb-max")];
  const seated = bbSeated();
  const half = BB_VIEW.span / 2;
  return {
    type: "start",
    N,
    span: BB_VIEW.span,
    seated,
    x0: seated ? -half : BB_VIEW.re - half,
    y0: seated ? BB_VIEW.re - half : -half,
    escape: K.escape,
    lims,
    max: Math.max(...lims),
    min: K.escape ? BB_MINS[+bbEl("bb-min").value] : 0,
  };
};

const bbStartWorkers = () => {
  bbStopWorkers();
  if (!BB.running || BB.settled || document.hidden) return;
  const job = bbJob();
  const gen = BB.gen;
  for (let i = 0; i < bbWorkerCount(); i++) {
    const w = new Worker(BB_WORKER_URL);
    w.onmessage = (e) => bbOnHits(e.data, w, gen);
    w.postMessage(job);
    BB.workers.push(w);
  }
};

const bbOnHits = (m, w, gen) => {
  if (gen !== BB.gen) return;
  const a = new Uint32Array(m.buf);
  const n = m.n;
  const H = BB.hist;
  if (H.length === 1) {
    const h = H[0];
    for (let j = 0; j < n; j++) h[a[j] >>> 3]++;
  } else {
    const [r, g, b] = H;
    for (let j = 0; j < n; j++) {
      const e = a[j];
      const i = e >>> 3;
      if (e & 1) r[i]++;
      if (e & 2) g[i]++;
      if (e & 4) b[i]++;
    }
  }
  BB.points += n;
  BB.orbits += m.orbits;
  BB.samples += m.samples;
  BB.dirty = true;
  w.postMessage({ type: "buf", buf: m.buf }, [m.buf]);
  bbWake();
};

// ------------------------------------------------------------ the picture

const hexRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
let bbLUT = null; // 1024 entries of rgb
const bbBuildLUT = () => {
  const pal = BB_PALETTES[bbEl("bb-palette").value];
  const stops = pal.stops.map(hexRGB);
  bbLUT = new Uint8ClampedArray(1024 * 3);
  for (let i = 0; i < 1024; i++) {
    const t = (i / 1023) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) bbLUT[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f;
  }
  BB.bg = pal.bg;
};

// The brightest pixels (along the real axis) would make all the rest dark:
// the white point is set at a high percentile of the lit pixels instead.
// Also returns the count of an ordinary lit pixel (90th percentile), to tell
// when the faint parts are smooth too.
const bbLevels = (h) => {
  const N = h.length;
  const s = [];
  for (let i = 0; i < 30000; i++) {
    const v = h[(Math.random() * N) | 0];
    if (v) s.push(v);
  }
  if (s.length < 20) return [1, 0];
  s.sort((a, b) => a - b);
  return [Math.max(1, s[Math.floor(s.length * 0.995)]), s[Math.floor(s.length * 0.9)]];
};

const bbRender = () => {
  const cv = bbEl("bb-canvas");
  const N = BB.size;
  if (cv.width !== N) {
    cv.width = N;
    cv.height = N;
    BB.img = null;
  }
  const ctx = cv.getContext("2d");
  if (!BB.img) BB.img = ctx.createImageData(N, N);
  const d = BB.img.data;
  const ex = +bbEl("bb-exposure").value;
  const gm = +bbEl("bb-contrast").value;
  const levels = BB.hist.map(bbLevels);
  const whites = levels.map((l) => l[0]);
  if (BB.hist.length === 1) {
    const h = BB.hist[0];
    const sc = ex / whites[0];
    const bg = BB.bg;
    // a table from count to color: counts are integers, most of them small
    const cap = Math.ceil(whites[0] / ex) + 1;
    const tab = new Int32Array(Math.min(cap + 1, 1 << 20));
    for (let v = 0; v < tab.length; v++) tab[v] = Math.min(1023, (Math.pow(Math.min(1, v * sc), gm) * 1023) | 0) * 3;
    const last = tab.length - 1;
    for (let i = 0, n = N * N; i < n; i++) {
      const v = h[i];
      const o = i * 4;
      if (!v) {
        d[o] = bg[0];
        d[o + 1] = bg[1];
        d[o + 2] = bg[2];
      } else {
        const j = tab[v < last ? v : last];
        d[o] = bbLUT[j];
        d[o + 1] = bbLUT[j + 1];
        d[o + 2] = bbLUT[j + 2];
      }
      d[o + 3] = 255;
    }
  } else {
    for (let c = 0; c < 3; c++) {
      const h = BB.hist[c];
      const sc = ex / whites[c];
      const cap = Math.min(1 << 20, Math.ceil(whites[c] / ex) + 2);
      const tab = new Uint8ClampedArray(cap);
      for (let v = 0; v < cap; v++) tab[v] = Math.pow(Math.min(1, v * sc), gm) * 255;
      const last = cap - 1;
      for (let i = 0, n = N * N; i < n; i++) {
        const v = h[i];
        d[i * 4 + c] = tab[v < last ? v : last];
      }
    }
    for (let i = 3, n = N * N * 4; i < n; i += 4) d[i] = 255;
  }
  ctx.putImageData(BB.img, 0, 0);
  // settled when even the faintest channel is fed well enough
  BB.progress = Math.min(1, ...levels.map(([w]) => w / BB_SETTLE));
  // the orbits of the Anti-Buddhabrot pile up on a few points each: it takes
  // many orbits, not just many points, to smooth it
  if (!bbKind().escape) BB.progress = Math.min(BB.progress, BB.orbits / (BB_ANTI_ORBITS * BB.size * BB.size));
  if (window.BB_DEBUG) console.log(levels.map((l) => l.join("/")).join("  "));
  bbInfo();
};

const bbFmt = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + " billion" : n >= 1e6 ? (n / 1e6).toFixed(1) + " million" : Math.round(n / 1e3) + " thousand";

const bbInfo = () => {
  const s = (performance.now() - BB.t0) / 1000;
  const state = BB.settled
    ? `Done in ${s.toFixed(0)} s: ${bbFmt(BB.points)} points, nothing changes anymore.`
    : `${bbFmt(BB.orbits)} orbits, ${bbFmt(BB.points)} points, ${Math.round(BB.progress * 100)}% sharp.`;
  bbEl("bb-info").textContent = state;
  bbEl("bb-bar").style.width = `${BB.progress * 100}%`;
};

const bbLoop = (now) => {
  BB.raf = 0;
  if (!BB.dirty) return;
  // a render costs a little time: not more than 4 times a second
  if (now - BB.lastRender < 250) return bbWake();
  BB.lastRender = now;
  BB.dirty = false;
  bbRender();
  if (BB.progress >= 1 && !BB.settled) {
    BB.settled = true;
    bbStopWorkers();
    bbInfo();
    bbEl("bb-pause").disabled = true;
  }
};
const bbWake = () => {
  if (!BB.raf) BB.raf = requestAnimationFrame(bbLoop);
};

const bbRestart = () => {
  BB.gen++;
  BB.size = +bbEl("bb-res").value;
  const ch = bbKind().rgb ? 3 : 1;
  BB.hist = Array.from({ length: ch }, () => new Uint32Array(BB.size * BB.size));
  BB.samples = 0;
  BB.orbits = 0;
  BB.points = 0;
  BB.progress = 0;
  BB.settled = false;
  BB.t0 = performance.now();
  bbEl("bb-pause").disabled = false;
  bbStartWorkers();
  BB.dirty = true;
  bbWake();
  bbWriteHash();
  bbDrawSet();
};

// ------------------------------------------------------------ the orbit under the pointer

// canvas pixel (0..1) <-> complex number
const bbToC = (u, v) => {
  const s = BB_VIEW.span;
  return bbSeated() ? [BB_VIEW.re - s / 2 + v * s, -(u - 0.5) * s] : [BB_VIEW.re - s / 2 + u * s, -(v - 0.5) * s];
};
const bbFromC = (re, im) => {
  const s = BB_VIEW.span;
  const a = (re - (BB_VIEW.re - s / 2)) / s;
  return bbSeated() ? [0.5 - im / s, a] : [a, 0.5 - im / s];
};

const bbOverlay = () => {
  const ov = bbEl("bb-overlay");
  const r = ov.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(r.width * dpr);
  if (ov.width !== w) {
    ov.width = w;
    ov.height = w;
  }
  return ov;
};

let bbSetMask = null; // the Mandelbrot set, for the outline
const bbDrawSet = (orbit) => {
  const ov = bbOverlay();
  const ctx = ov.getContext("2d");
  const W = ov.width;
  ctx.clearRect(0, 0, W, W);
  if (bbEl("bb-set").checked) {
    if (!bbSetMask || bbSetMask.seated !== bbSeated() || bbSetMask.W !== W) bbSetMask = bbMakeSet(W);
    ctx.drawImage(bbSetMask.cv, 0, 0, W, W);
  }
  if (orbit) bbDrawOrbit(ctx, W, orbit);
};

// the outline of the Mandelbrot set, as a thin line
const bbMakeSet = (W) => {
  const n = Math.min(W, 600);
  const inside = new Uint8Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const [cr, ci] = bbToC((x + 0.5) / n, (y + 0.5) / n);
      let zr = 0;
      let zi = 0;
      let i = 0;
      for (; i < 300 && zr * zr + zi * zi <= 4; i++) {
        const t = zr * zr - zi * zi + cr;
        zi = 2 * zr * zi + ci;
        zr = t;
      }
      inside[y * n + x] = i === 300 ? 1 : 0;
    }
  const cv = document.createElement("canvas");
  cv.width = n;
  cv.height = n;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(n, n);
  for (let y = 1; y < n - 1; y++)
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      if (inside[i] && !(inside[i - 1] && inside[i + 1] && inside[i - n] && inside[i + n])) {
        img.data[i * 4] = 255;
        img.data[i * 4 + 1] = 255;
        img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = 150;
      }
    }
  ctx.putImageData(img, 0, 0);
  return { cv, seated: bbSeated(), W };
};

const bbOrbit = (cr, ci) => {
  const pts = [];
  let zr = 0;
  let zi = 0;
  const max = 1000;
  let i = 0;
  for (; i < max; i++) {
    const t = zr * zr - zi * zi + cr;
    zi = 2 * zr * zi + ci;
    zr = t;
    if (i < 300) pts.push([zr, zi]);
    if (zr * zr + zi * zi > 4) break;
  }
  return { c: [cr, ci], pts, escaped: i < max, steps: i + 1 };
};

const bbDrawOrbit = (ctx, W, o) => {
  const dpr = window.devicePixelRatio || 1;
  const xy = (re, im) => bbFromC(re, im).map((v) => v * W);
  const col = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e2560b";
  ctx.lineWidth = 1 * dpr;
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.beginPath();
  ctx.moveTo(...xy(0, 0));
  o.pts.forEach(([re, im]) => ctx.lineTo(...xy(re, im)));
  ctx.stroke();
  ctx.fillStyle = "#fff";
  o.pts.forEach(([re, im]) => {
    const [x, y] = xy(re, im);
    ctx.beginPath();
    ctx.arc(x, y, 1.8 * dpr, 0, 2 * Math.PI);
    ctx.fill();
  });
  const [x, y] = xy(...o.c);
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(x, y, 4.5 * dpr, 0, 2 * Math.PI);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  const [cr, ci] = o.c;
  const c = `c = ${cr.toFixed(3)} ${ci < 0 ? "−" : "+"} ${Math.abs(ci).toFixed(3)}i`;
  bbEl("bb-orbit").textContent = o.escaped
    ? `${c} escapes after ${o.steps} steps: its orbit is part of the Buddhabrot.`
    : `${c} never escapes: it is in the Mandelbrot set, and its orbit feeds the Anti-Buddhabrot.`;
};

const bbTrace = (e) => {
  if (!bbEl("bb-trace").checked) return;
  const r = bbEl("bb-overlay").getBoundingClientRect();
  const u = (e.clientX - r.left) / r.width;
  const v = (e.clientY - r.top) / r.height;
  if (u < 0 || v < 0 || u > 1 || v > 1) return bbUntrace();
  bbDrawSet(bbOrbit(...bbToC(u, v)));
};
const bbUntrace = () => {
  bbEl("bb-orbit").textContent = "";
  bbDrawSet();
};

// ------------------------------------------------------------ controls

const bbIterLabel = (id) => {
  const v = id === "bb-min" ? BB_MINS[+bbEl(id).value] : bbIter(id);
  bbEl(id + "-val").textContent = v.toLocaleString("en-US");
};

const bbShowKind = () => {
  const K = bbKind();
  bbEl("bb-note").textContent = K.note;
  bbEl("bb-rgb").hidden = !K.rgb;
  bbEl("bb-single").hidden = K.rgb;
  bbEl("bb-palette-label").hidden = K.rgb;
  bbEl("bb-min-label").hidden = !K.escape;
};

const BB_KEYS = ["kind", "max", "min", "r", "g", "b", "palette", "exposure", "contrast", "orient", "res"];
const bbWriteHash = () => {
  const q = BB_KEYS.map((k) => `${k}=${encodeURIComponent(bbEl("bb-" + k).value)}`);
  history.replaceState(null, "", "#" + q.join("&"));
};

const bbSetIter = (id, v, list = BB_ITERS) => {
  const i = list.indexOf(v);
  if (i >= 0) bbEl(id).value = i;
  bbIterLabel(id);
};

let bbPresetIdx = 0;
const bbApplyPreset = (p) => {
  bbEl("bb-kind").value = p.kind;
  if (p.max) bbSetIter("bb-max", p.max);
  if (p.r) ["r", "g", "b"].forEach((c) => bbSetIter("bb-" + c, p[c]));
  bbSetIter("bb-min", p.min, BB_MINS);
  if (p.palette) bbEl("bb-palette").value = p.palette;
  bbEl("bb-exposure").value = p.exposure;
  bbEl("bb-contrast").value = p.contrast;
  bbShowKind();
  bbBuildLUT();
  bbRestart();
};

const bbSetRunning = (on) => {
  BB.running = on;
  bbEl("bb-pause").textContent = on ? "Pause" : "Play";
  if (on) bbStartWorkers();
  else bbStopWorkers();
};

const initBuddhabrot = () => {
  bbEl("bb-kind").innerHTML = Object.keys(BB_KINDS).map((n) => `<option>${n}</option>`).join("");
  bbEl("bb-palette").innerHTML = Object.keys(BB_PALETTES).map((n) => `<option>${n}</option>`).join("");
  ["bb-max", "bb-r", "bb-g", "bb-b"].forEach((id) => (bbEl(id).max = BB_ITERS.length - 1));
  bbEl("bb-min").max = BB_MINS.length - 1;
  const h = new URLSearchParams(location.hash.slice(1));
  const p = BB_PRESETS[0];
  bbEl("bb-kind").value = p.kind;
  bbSetIter("bb-max", p.max);
  bbSetIter("bb-min", p.min, BB_MINS);
  ["r", "g", "b"].forEach((c) => bbSetIter("bb-" + c, BB_PRESETS[1][c]));
  bbEl("bb-palette").value = p.palette;
  bbEl("bb-exposure").value = p.exposure;
  bbEl("bb-contrast").value = p.contrast;
  if (h.has("kind") && BB_KINDS[h.get("kind")])
    BB_KEYS.forEach((k) => {
      if (!h.has(k)) return;
      const el = bbEl("bb-" + k);
      const v = h.get(k);
      if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === v)) return;
      el.value = v;
    });
  ["bb-max", "bb-r", "bb-g", "bb-b", "bb-min"].forEach(bbIterLabel);
  bbShowKind();
  bbBuildLUT();

  bbEl("bb-kind").addEventListener("change", () => {
    bbShowKind();
    bbRestart();
  });
  ["bb-max", "bb-r", "bb-g", "bb-b", "bb-min"].forEach((id) => {
    bbEl(id).addEventListener("input", () => bbIterLabel(id));
    bbEl(id).addEventListener("change", bbRestart);
  });
  ["bb-orient", "bb-res"].forEach((id) => bbEl(id).addEventListener("change", bbRestart));
  bbEl("bb-palette").addEventListener("change", () => {
    bbBuildLUT();
    bbRender();
    bbWriteHash();
  });
  ["bb-exposure", "bb-contrast"].forEach((id) =>
    bbEl(id).addEventListener("input", () => {
      bbRender();
      bbWriteHash();
    }),
  );
  bbEl("bb-preset").addEventListener("click", () => {
    bbPresetIdx = (bbPresetIdx + 1) % BB_PRESETS.length;
    bbApplyPreset(BB_PRESETS[bbPresetIdx]);
  });
  bbEl("bb-pause").addEventListener("click", () => bbSetRunning(!BB.running));
  bbEl("bb-png").addEventListener("click", () =>
    bbEl("bb-canvas").toBlob((b) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `${bbEl("bb-kind").value.toLowerCase()}.png`;
      a.click();
    }),
  );
  bbEl("bb-set").addEventListener("change", () => bbDrawSet());
  bbEl("bb-trace").addEventListener("change", bbUntrace);
  const ov = bbEl("bb-overlay");
  ov.addEventListener("pointermove", bbTrace);
  ov.addEventListener("pointerdown", bbTrace);
  ov.addEventListener("pointerleave", bbUntrace);
  addEventListener("resize", () => bbDrawSet());
  // no work in a hidden tab
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) bbStopWorkers();
    else if (BB.running && !BB.settled) bbStartWorkers();
  });
  bbRestart();
};
