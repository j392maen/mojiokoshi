/* Sound Field — a ridgeline of voices that listens to the pointer, rises when a
 * file is dragged in, and collapses into a single line when one is dropped.  */
(() => {
  "use strict";

  // ---- 3D simplex noise (Gustavson), seeded ------------------------------
  const perm = new Uint8Array(512);
  {
    const p = Array.from({ length: 256 }, (_, i) => i);
    let seed = 0x9e3779b9;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  }
  const G3 = [1,1,0, -1,1,0, 1,-1,0, -1,-1,0, 1,0,1, -1,0,1, 1,0,-1, -1,0,-1, 0,1,1, 0,-1,1, 0,1,-1, 0,-1,-1];
  const F3 = 1 / 3, G = 1 / 6;
  function noise3(x, y, z) {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
    const t = (i + j + k) * G;
    const x0 = x - i + t, y0 = y - j + t, z0 = z - k + t;
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G, y1 = y0 - j1 + G, z1 = z0 - k1 + G;
    const x2 = x0 - i2 + 2 * G, y2 = y0 - j2 + 2 * G, z2 = z0 - k2 + 2 * G;
    const x3 = x0 - 1 + 0.5, y3 = y0 - 1 + 0.5, z3 = z0 - 1 + 0.5;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0;
    const corner = (gi, cx, cy, cz) => {
      let tt = 0.6 - cx * cx - cy * cy - cz * cz;
      if (tt < 0) return 0;
      tt *= tt;
      const g = (gi % 12) * 3;
      return tt * tt * (G3[g] * cx + G3[g + 1] * cy + G3[g + 2] * cz);
    };
    n += corner(perm[ii + perm[jj + perm[kk]]], x0, y0, z0);
    n += corner(perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]], x1, y1, z1);
    n += corner(perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]], x2, y2, z2);
    n += corner(perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]], x3, y3, z3);
    return 32 * n; // ~[-1, 1]
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 4);
  const easeInOut = (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2);

  const canvas = document.getElementById("field");
  const ctx = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");

  let W = 0, H = 0, dpr = 1;
  let ink = "#0b0b0c", paperRGB = "236 232 223", shuRGB = "255 74 28";
  let running = false, last = 0, time = 0;
  let intro = 0;            // 0 → 1 once, on first show
  let drag = 0, dragTarget = 0;
  let presence = 1, presenceFrom = 1, presenceTo = 1, presenceT = 1;
  let collapseY = 0;
  let pulse = 0;            // a short swell when files land
  const pointer = { x: -1e4, y: -1e4, sx: -1e4, sy: -1e4, energy: 0 };

  function readColors() {
    const css = getComputedStyle(document.documentElement);
    ink = css.getPropertyValue("--ink").trim() || ink;
    paperRGB = css.getPropertyValue("--paper-rgb").trim() || paperRGB;
    shuRGB = css.getPropertyValue("--shu-rgb").trim() || shuRGB;
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!running) draw();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    if (presence <= 0.001 && drag <= 0.001) return;

    const top = H * 0.5;
    const bottom = H * 0.955;
    const count = clamp(Math.round((bottom - top) / 8.5), 26, 60);
    const gap = (bottom - top) / (count - 1);
    const step = W > 1600 ? 6 : 5;
    const t = time;
    const d = drag;
    const p = easeInOut(presence);
    const amp = gap * (5.2 + d * 7 + pulse * 6) * p;

    // Two drifting resonances give the ridge an organic, off-centre silhouette.
    const c1 = W * (0.6 + 0.05 * Math.sin(t * 0.07)) * (1 - d) + W * 0.5 * d;
    const c2 = W * (0.3 + 0.04 * Math.cos(t * 0.05));
    const w1 = W * lerp(0.17, 0.2, d), w2 = W * 0.11;

    const pxs = pointer.sx, pys = pointer.sy;
    const pe = pointer.energy;

    for (let i = 0; i < count; i++) {
      const depth = i / (count - 1); // 0 = back, 1 = front
      const baseY = lerp(collapseY, top + i * gap, p);
      const xEnd = W;
      const voice = 0.55 + 0.45 * noise3(i * 0.31, 7.3, t * 0.16); // lines "speak" at different times

      ctx.beginPath();
      ctx.moveTo(0, baseY);
      for (let x = 0; x <= xEnd + step; x += step) {
        const env =
          0.05 +
          Math.exp(-((x - c1) ** 2) / (2 * w1 * w1)) +
          0.55 * Math.exp(-((x - c2) ** 2) / (2 * w2 * w2)) * (1 - d);
        let n = noise3(x * 0.0085, i * 0.19, t * 0.32);
        n = Math.max(0, n * 0.5 + 0.5);
        n = n * n * (1.4 - 0.4 * n);
        let lift = amp * env * n * voice;
        if (pe > 0.001) {
          const dx = x - pxs, dy = baseY - pys;
          lift += gap * 7 * pe * p * Math.exp(-(dx * dx) / 9000 - (dy * dy) / 16000) * (0.6 + 0.4 * noise3(x * 0.03, i, t * 1.4));
        }
        ctx.lineTo(Math.min(x, xEnd), baseY - lift);
      }
      // Occlude everything behind this line, like ink pooling under a stroke.
      ctx.lineTo(xEnd, H + 2);
      ctx.lineTo(0, H + 2);
      ctx.closePath();
      ctx.fillStyle = ink;
      ctx.fill();

      const alpha = (0.14 + 0.5 * depth * depth) * Math.min(1, p * 1.6);
      const hot = d * Math.exp(-((depth - 0.62) ** 2) / 0.02);
      ctx.strokeStyle = hot > 0.02
        ? `rgb(${shuRGB} / ${clamp(alpha + hot * 0.6, 0, 1)})`
        : `rgb(${paperRGB} / ${alpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // First appearance: a soft diagonal wipe, front lines first.
    if (intro < 1 && !reduce.matches) {
      const dx = W * 0.85, dy = -W * 0.4;
      const span = Math.hypot(dx, dy);
      const edge = -400 + easeOut(intro) * (span + 800);
      const g = ctx.createLinearGradient(0, H, dx, H + dy);
      const at = (v) => clamp(v / span, 0, 1);
      g.addColorStop(at(edge - 400), "rgb(0 0 0 / 0)");
      g.addColorStop(at(edge), "rgb(0 0 0 / 1)");
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
    }

    // Feather the edges into the page.
    const fadeX = Math.min(220, W * 0.14);
    let g = ctx.createLinearGradient(0, 0, fadeX, 0);
    g.addColorStop(0, ink);
    g.addColorStop(1, hexAlpha(ink, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, top - gap * 14, fadeX, H);
    g = ctx.createLinearGradient(W - fadeX, 0, W, 0);
    g.addColorStop(0, hexAlpha(ink, 0));
    g.addColorStop(1, ink);
    ctx.fillStyle = g;
    ctx.fillRect(W - fadeX, top - gap * 14, fadeX, H);
    g = ctx.createLinearGradient(0, H - 90, 0, H);
    g.addColorStop(0, hexAlpha(ink, 0));
    g.addColorStop(1, ink);
    ctx.fillStyle = g;
    ctx.fillRect(0, H - 90, W, 90);
  }

  function hexAlpha(hex, a) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
    return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${a})`;
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;

    const speed = reduce.matches ? 0 : 1 + drag * 1.8 + pulse * 2;
    time += dt * speed;
    intro = Math.min(1, intro + dt / 2.2);
    drag += (dragTarget - drag) * (1 - Math.exp(-dt * 5));
    pulse *= Math.exp(-dt * 2.2);

    if (presenceT < 1) {
      presenceT = Math.min(1, presenceT + dt / 1.15);
      presence = lerp(presenceFrom, presenceTo, presenceT);
    }

    const k = 1 - Math.exp(-dt * 7);
    pointer.sx += (pointer.x - pointer.sx) * k;
    pointer.sy += (pointer.y - pointer.sy) * k;
    pointer.energy *= Math.exp(-dt * 1.4);

    draw();

    // Sleep once the field has left the stage; wake on demand.
    if (presence <= 0.001 && presenceT >= 1 && drag < 0.001 && dragTarget === 0) {
      running = false;
      ctx.clearRect(0, 0, W, H);
      return;
    }
    requestAnimationFrame(frame);
  }

  function wake() {
    if (running || document.hidden) return;
    running = true;
    last = 0;
    requestAnimationFrame(frame);
  }

  addEventListener("pointermove", (e) => {
    const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;
    if (pointer.x < -1e3) { pointer.sx = e.clientX; pointer.sy = e.clientY; }
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.energy = Math.min(1, pointer.energy + Math.hypot(dx, dy) / 260);
  }, { passive: true });
  addEventListener("dragover", (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.energy = Math.min(1, pointer.energy + 0.04);
  });
  addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => (document.hidden ? (running = false) : presence > 0 && wake()));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readColors(); wake(); });

  window.Field = {
    start() {
      readColors();
      resize();
      wake();
    },
    setDrag(on) {
      dragTarget = on ? 1 : 0;
      wake();
    },
    /** Fold every line into one at viewport y, then sleep. */
    collapse(y) {
      collapseY = y;
      presenceFrom = presence;
      presenceTo = 0;
      presenceT = reduce.matches ? 1 : 0;
      if (reduce.matches) presence = 0;
      pulse = 0.6;
      wake();
    },
    expand() {
      presenceFrom = presence;
      presenceTo = 1;
      presenceT = reduce.matches ? 1 : 0;
      if (reduce.matches) presence = 1;
      wake();
    },
    pulse() {
      pulse = 1;
      wake();
    },
  };
})();
