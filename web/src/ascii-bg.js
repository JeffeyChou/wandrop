import { onThemeChange } from './theme.js';

// Flowing ASCII field: layered sine "liquid" interference + a ripple that follows the pointer.
const RAMP = ' .·:-=+*≡%#@';

export function startAsciiBackground(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true });
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CELL = 18;
  let cols = 0, rows = 0, dpr = 1, colors = [], raf = 0, last = 0;
  const pointer = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4 };

  function readColors() {
    const s = getComputedStyle(document.documentElement);
    colors = [s.getPropertyValue('--ascii-a').trim(), s.getPropertyValue('--ascii-b').trim()];
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, hgt = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(hgt * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    cols = Math.ceil(w / CELL);
    rows = Math.ceil(hgt / CELL);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `500 ${CELL * 0.72}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    draw(performance.now());
  }

  function draw(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pointer.x += (pointer.tx - pointer.x) * 0.08;
    pointer.y += (pointer.ty - pointer.y) * 0.08;
    const pc = pointer.x / CELL, pr = pointer.y / CELL;
    const T = t * 0.00035;
    // Bucket glyphs by level so fillStyle/alpha change only a few times per frame.
    const buckets = Array.from({ length: RAMP.length }, () => []);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let v = Math.sin(c * 0.09 + T * 1.3) + Math.sin(r * 0.13 - T * 0.9)
          + Math.sin((c + r) * 0.05 + T * 1.7) + Math.sin(Math.hypot(c - cols * 0.7, r - rows * 0.3) * 0.16 - T * 2.2);
        v = (v + 4) / 8; // 0..1
        const d = Math.hypot(c - pc, r - pr);
        if (d < 12) v += Math.cos(d * 0.9 - t * 0.006) * (1 - d / 12) * 0.35;
        v = Math.pow(Math.min(Math.max(v, 0), 1), 2.2);
        const level = Math.floor(v * (RAMP.length - 1));
        if (level > 0) buckets[level].push(c, r);
      }
    }
    for (let l = 1; l < RAMP.length; l++) {
      const b = buckets[l];
      if (!b.length) continue;
      ctx.fillStyle = l > RAMP.length * 0.6 ? colors[0] : colors[1];
      ctx.globalAlpha = 0.12 + (l / RAMP.length) * 0.5;
      for (let i = 0; i < b.length; i += 2) ctx.fillText(RAMP[l], b[i] * CELL + CELL / 2, b[i + 1] * CELL + CELL / 2);
    }
    ctx.globalAlpha = 1;
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (t - last < 1000 / 24) return; // ~24 fps is plenty for ambience
    last = t;
    draw(t);
  }

  readColors();
  onThemeChange(() => { readColors(); draw(performance.now()); });
  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', (e) => { pointer.tx = e.clientX; pointer.ty = e.clientY; }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(raf);
    if (!document.hidden && !reduced) raf = requestAnimationFrame(loop);
  });
  document.fonts?.ready.then(resize);
  resize();
  if (!reduced) raf = requestAnimationFrame(loop);
}

/** "Decode" effect: scramble glyphs into the final text. */
export function scrambleIn(el, finalText, duration = 900) {
  const glyphs = '#%@*+=-:.<>/\\|_';
  const start = performance.now();
  const chars = [...finalText];
  function frame(t) {
    const p = Math.min((t - start) / duration, 1);
    el.textContent = chars.map((ch, i) => {
      if (ch === ' ' || ch === '\n') return ch;
      return i / chars.length < p ? ch : glyphs[(Math.random() * glyphs.length) | 0];
    }).join('');
    if (p < 1) requestAnimationFrame(frame);
  }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) el.textContent = finalText;
  else requestAnimationFrame(frame);
}
