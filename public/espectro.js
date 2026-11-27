/* espectro.js — indicador de voz da co-apresentadora, por cima da página, só enquanto ela fala.
   Visual (15/11, pedido do Jonathan): 5 barras brancas translúcidas, compridas e arredondadas, no canto superior
   direito (logo abaixo do selo "Calíope ouvindo", se ele estiver na tela), que sobem e descem enquanto ela fala.
   Sem texto, sem brilho; fade suave de entrada e saída.
   O stage.mjs injeta este arquivo em cada aba do palco (relendo o arquivo a cada fala: mudar o visual não exige
   reiniciar o servidor) e o painel o carrega com <script>.
   API: window.__caliEspectro.cmd({ acao: 'sintetico' })   começa (ela começou a falar)
                                  .cmd({ acao: 'parar' })       some suavemente
        window.__caliEspectro.destroy()                         remove (quando chega uma versão nova do arquivo)
   A animação é sintética (ruído suave com ritmo de sílabas): o painel não toca nem analisa o áudio para isso,
   para não arriscar a qualidade da voz. */
(() => {
  if (window.__caliEspectro) return;
  const N = 5, H = 58, LINGER = 450;
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let root, bars = [], raf = 0, on = false, t0 = 0, stopAt = 0, last = 0, dead = false;
  const val = new Float32Array(N);

  function build() {
    if (root?.isConnected || dead) return;
    const css = document.createElement('style');
    css.textContent = `
#__cali_espectro{position:fixed;right:22px;top:16px;z-index:2147483645;pointer-events:none;display:flex;align-items:center;gap:7px;
  height:${H}px;opacity:0;transform:translateY(-6px) scale(.92);transform-origin:100% 0;
  transition:opacity .45s ease,transform .5s cubic-bezier(.2,.8,.3,1)}
#__cali_espectro.on{opacity:1;transform:none}
#__cali_espectro i{display:block;width:9px;height:${H}px;border-radius:9px;transform:scaleY(.18);will-change:transform;
  background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.85);
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:0 2px 8px rgba(0,0,0,.16)}
@media (prefers-reduced-motion:reduce){#__cali_espectro,#__cali_espectro.on{transform:none;transition:opacity .7s ease}}`;
    root = document.createElement('div');
    root.id = '__cali_espectro';
    root.setAttribute('aria-hidden', 'true');
    root.append(css);
    bars = Array.from({ length: N }, () => root.appendChild(document.createElement('i')));
    (document.body || document.documentElement).appendChild(root);
  }

  // canto superior direito; se o selo do palco (#__caliope_badge) estiver lá, logo abaixo dele
  function place() {
    const b = document.getElementById('__caliope_badge')?.getBoundingClientRect();
    root.style.top = (b && b.height ? b.bottom + 10 : 16).toFixed(0) + 'px';
  }

  const seed = Array.from({ length: 64 }, () => Math.random());
  const noise = t => { const i = Math.floor(t), f = t - i, a = seed[i & 63], b = seed[(i + 1) & 63]; return a + (b - a) * f * f * (3 - 2 * f); };

  function frame(now) {
    raf = 0;
    if (dead) return;
    if (now - last < 33) { raf = requestAnimationFrame(frame); return; }   // ~30 fps basta
    last = now;
    const reduced = calm(), t = (now - t0) / 1000;
    // envelope de fala: sílabas a ~4–5 Hz, com frases que respiram
    const syl = Math.max(0, Math.sin(t * 2 * Math.PI * (4 + noise(t * .6) * 1.3)));
    const env = .35 + .65 * syl * (.5 + .5 * noise(t * 1.7 + 5));
    for (let k = 0; k < N; k++) {
      const center = 1 - Math.abs(k - (N - 1) / 2) / N * .9;           // as do meio sobem mais
      let want = on ? Math.min(1, .16 + env * center * (.45 + .7 * noise(t * 5 + k * 4.1))) : .18;
      if (reduced) want = on ? .3 + .25 * (.5 + .5 * Math.sin(t * 2 + k)) : .18;   // calmo: ondula devagar
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
    if (m.acao === 'sintetico' || m.acao === 'tocar') {
      build(); place();
      if (!on) t0 = performance.now();
      on = true; root.classList.add('on'); loop();
    } else if (m.acao === 'parar' && on) { on = false; stopAt = performance.now(); loop(); }
    return { ok: true, falando: on };
  }
  function destroy() { dead = true; cancelAnimationFrame(raf); root?.remove(); }
  window.__caliEspectro = { cmd, destroy };
})();
