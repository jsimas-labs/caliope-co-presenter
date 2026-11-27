/* spectrum.js — the co-presenter's voice indicator, over the page, only while she speaks.
   Look (Nov 15, the presenter's request): 5 translucent white bars, long and rounded, in the top right corner
   (just below the "Calíope listening" badge, if it is on screen), going up and down while she speaks.
   No text, no glow; smooth fade in and out.
   stage.mjs injects this file into every stage tab (re-reading the file on every utterance: changing the look needs
   no server restart) and the panel loads it with <script>.
   API: window.__caliSpectrum.cmd({ action: 'synthetic' })   starts (she started speaking)
                                 .cmd({ action: 'stop' })        fades out
        window.__caliSpectrum.destroy()                          removes it (when a new version of the file arrives)
   The animation is synthetic (smooth noise with a syllable rhythm): the panel neither plays nor analyzes the audio
   for it, so the voice quality is never at risk. */
(() => {
  if (window.__caliSpectrum) return;
  const N = 5, H = 58, LINGER = 450;
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let root, bars = [], raf = 0, on = false, t0 = 0, stopAt = 0, last = 0, dead = false;
  const val = new Float32Array(N);

  function build() {
    if (root?.isConnected || dead) return;
    const css = document.createElement('style');
    css.textContent = `
#__cali_spectrum{position:fixed;right:22px;top:16px;z-index:2147483645;pointer-events:none;display:flex;align-items:center;gap:7px;
  height:${H}px;opacity:0;transform:translateY(-6px) scale(.92);transform-origin:100% 0;
  transition:opacity .45s ease,transform .5s cubic-bezier(.2,.8,.3,1)}
#__cali_spectrum.on{opacity:1;transform:none}
#__cali_spectrum i{display:block;width:9px;height:${H}px;border-radius:9px;transform:scaleY(.18);will-change:transform;
  background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.85);
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:0 2px 8px rgba(0,0,0,.16)}
@media (prefers-reduced-motion:reduce){#__cali_spectrum,#__cali_spectrum.on{transform:none;transition:opacity .7s ease}}`;
    root = document.createElement('div');
    root.id = '__cali_spectrum';
    root.setAttribute('aria-hidden', 'true');
    root.append(css);
    bars = Array.from({ length: N }, () => root.appendChild(document.createElement('i')));
    (document.body || document.documentElement).appendChild(root);
  }

  // top right corner; if the stage badge (#__caliope_badge) is there, just below it
  function place() {
    const b = document.getElementById('__caliope_badge')?.getBoundingClientRect();
    root.style.top = (b && b.height ? b.bottom + 10 : 16).toFixed(0) + 'px';
  }

  const seed = Array.from({ length: 64 }, () => Math.random());
  const noise = t => { const i = Math.floor(t), f = t - i, a = seed[i & 63], b = seed[(i + 1) & 63]; return a + (b - a) * f * f * (3 - 2 * f); };

  function frame(now) {
    raf = 0;
    if (dead) return;
    if (now - last < 33) { raf = requestAnimationFrame(frame); return; }   // ~30 fps is enough
    last = now;
    const reduced = calm(), t = (now - t0) / 1000;
    // speech envelope: syllables at ~4–5 Hz, with breathing phrases
    const syl = Math.max(0, Math.sin(t * 2 * Math.PI * (4 + noise(t * .6) * 1.3)));
    const env = .35 + .65 * syl * (.5 + .5 * noise(t * 1.7 + 5));
    for (let k = 0; k < N; k++) {
      const center = 1 - Math.abs(k - (N - 1) / 2) / N * .9;           // the middle ones go higher
      let want = on ? Math.min(1, .16 + env * center * (.45 + .7 * noise(t * 5 + k * 4.1))) : .18;
      if (reduced) want = on ? .3 + .25 * (.5 + .5 * Math.sin(t * 2 + k)) : .18;   // calm: slow wave
      const k2 = want > val[k] ? (reduced ? .12 : .45) : (reduced ? .08 : .2);
      val[k] += (want - val[k]) * k2;
      bars[k].style.transform = `scaleY(${val[k].toFixed(3)})`;
    }
    if (!on && now - stopAt > LINGER) root.classList.remove('on');
    if (on || now - stopAt < LINGER + 600) raf = requestAnimationFrame(frame);
  }
  const loop = () => { if (!raf) raf = requestAnimationFrame(frame); };

  function cmd(m = {}) {
    if (dead) return { ok: false };
    if (m.action === 'synthetic') {
      build(); place();
      if (!on) t0 = performance.now();
      on = true; root.classList.add('on'); loop();
    } else if (m.action === 'stop' && on) { on = false; stopAt = performance.now(); loop(); }
    return { ok: true, speaking: on };
  }
  function destroy() { dead = true; cancelAnimationFrame(raf); root?.remove(); }
  window.__caliSpectrum = { cmd, destroy };
})();
