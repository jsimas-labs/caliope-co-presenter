// test/guia.mjs — explicação guiada longa, sem microfone e sem chave (regra de 15/11):
// cada trecho termina só no fim real do áudio, nenhum é cortado nem pulado, nada avança por tempo,
// e só "<nome>, para" ou Esc param a sequência inteira.
//   npm test
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 8798, BASE = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(PORT), HEADLESS: '1', OPENAI_API_KEY: '', CALIOPE_VOZ: 'realtime', DECK_URL: `${BASE}/deck/guia.html` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((ok, fail) => { server.stdout.once('data', ok); server.once('exit', fail); });
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage();
  await page.goto(BASE);
  await page.click('#btnStage');
  await page.waitForFunction(() => /Agent Card/.test(document.getElementById('slideTitle').textContent));
  // ajudantes dentro do painel: a sessão da OpenAI é um canal falso que guarda o que o painel manda
  await page.evaluate(() => {
    window.__t = {
      wait: ms => new Promise(r => setTimeout(r, ms)),
      reset() { this.sent = []; dc = { readyState: 'open', send: m => this.sent.push(JSON.parse(m)) }; },
      falas() { return this.sent.filter(e => e.response?.metadata?.etapa === 'falar').map(e => e.response.instructions.split('\n').at(-1)); },
      async ate(cond, ms = 3000) { const t0 = performance.now(); while (!cond()) { if (performance.now() - t0 > ms) return -1; await this.wait(5); } return performance.now() - t0; },
    };
  });

  // 1) explicação inteira: intro + 5 trechos com fala; os passos 4, 5 e 8 não têm fala
  const r = await page.evaluate(async () => {
    const t = window.__t; t.reset();
    startGuided(await runTool('explicar_slide', {}));
    const lag = [];
    for (let k = 0; k < 6; k++) {
      if (await t.ate(() => t.falas().length === k + 1) < 0) return { erro: `trecho ${k} não começou`, falas: t.falas() };
      await onEvent({ type: 'output_audio_buffer.started' });
      await t.wait(1500);                         // trecho "longo": sem o fim do áudio, nada avança
      sayAloud('fala nova por cima');             // não entra nem corta
      await onEvent({ type: 'input_audio_buffer.speech_started', item_id: 'eco' + k });   // eco ou barulho: não corta
      await onEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'eco' + k, transcript: 'nada a ver com a entrada do banco' });
      if (t.falas().length !== k + 1) return { erro: `avançou sem o fim do áudio no trecho ${k}`, falas: t.falas() };
      const t0 = performance.now();
      await onEvent({ type: 'output_audio_buffer.stopped' });
      await onEvent({ type: 'output_audio_buffer.stopped' });   // fim duplicado não pula trecho
      if (k < 5) lag.push(await t.ate(() => t.falas().length === k + 2) + (performance.now() - t0) * 0);
    }
    await t.ate(() => !guided);
    return { falas: t.falas(), lag, guiadoAoFim: !!guided, cortes: t.sent.filter(e => e.type === 'response.cancel' || e.type === 'output_audio_buffer.clear').length };
  });
  assert.equal(r.erro, undefined, JSON.stringify(r));
  assert.deepEqual(r.falas.map(f => f.split('.')[0]), ['Vou explicar o Agent Card em oito passos', 'Primeiro passo', 'Segundo passo', 'Terceiro passo', 'Sexto passo', 'Sétimo passo']);
  assert.ok(r.falas[5].endsWith('pareça no palco.'));
  assert.ok(!r.falas.includes('fala nova por cima'));
  assert.equal(r.cortes, 0);
  assert.equal(r.guiadoAoFim, false);
  // os 8 passos acenderam, um por vez (o deck de teste ignora ←: só lê o estado)
  assert.equal((await page.evaluate(() => runTool('slide_anterior', {}))).slide?.passo, 8);
  // sem timer: antes havia 450 ms depois de cada fim de áudio e mais 1,5 s por passo sem fala; o próximo trecho sai logo depois do fim do áudio, inclusive depois dos passos 4 e 5 sem fala
  assert.ok(r.lag.every(ms => ms >= 0 && ms < 440), `atraso depois do fim do áudio: ${r.lag.map(Math.round)} ms`);
  console.log(`✓ explicação longa: intro + 5 trechos inteiros, em ordem, só no fim real do áudio (atraso ${r.lag.map(Math.round).join('/')} ms)`);
  console.log('✓ passos sem fala acendem junto com o seguinte, sem timer; eco, barulho e fala nova não cortam');

  // 2) "Caliope, para", "Calíope, para" e Esc no 4º trecho param a fala atual e a fila inteira
  for (const jeito of ['Caliope, para', 'Calíope, para', 'Esc']) {
    const s = await page.evaluate(async jeito => {
      const t = window.__t; t.reset();
      startGuided(await runTool('explicar_slide', {}));
      for (let k = 0; k < 3; k++) { await t.ate(() => t.falas().length === k + 1); await onEvent({ type: 'output_audio_buffer.started' }); await onEvent({ type: 'output_audio_buffer.stopped' }); }
      await t.ate(() => t.falas().length === 4); await onEvent({ type: 'output_audio_buffer.started' });
      if (jeito === 'Esc') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else {
        await onEvent({ type: 'input_audio_buffer.speech_started', item_id: 'p' });
        await onEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'p', transcript: jeito });
      }
      const n = t.falas().length;
      await onEvent({ type: 'output_audio_buffer.stopped' });
      await t.wait(500);
      return { parou: !guided, semNovas: t.falas().length === n, limpou: t.sent.some(e => e.type === 'output_audio_buffer.clear') };
    }, jeito);
    assert.deepEqual(s, { parou: true, semNovas: true, limpou: true });
    console.log(`✓ "${jeito}" no 4º trecho para a fala atual e a fila inteira`);
  }

  // 3) voz nativa que falha num trecho: a explicação para inteira, sem pular o trecho
  const v = await page.evaluate(async () => {
    const t = window.__t; t.reset();
    const vozAntes = config.voz, fetchAntes = window.fetch;
    config.voz = 'Luciana'; vozCache.clear();
    // o servidor de teste pode não ter o say (só no macOS): o áudio vem pronto, e o do 2º trecho falha
    window.fetch = (u, o) => !String(u).endsWith('/api/voz') ? fetchAntes(u, o)
      : Promise.resolve(/Segundo passo/.test(o?.body || '') ? new Response('', { status: 500 }) : new Response(new Blob([new Uint8Array(44)], { type: 'audio/wav' })));
    const tocadas = [];
    const playAntes = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { tocadas.push(this); return Promise.resolve(); };
    try {
      startGuided(await runTool('explicar_slide', {}));
      for (let k = 0; k < 2; k++) { await t.ate(() => tocadas.length === k + 1); tocadas[k].onended(); }   // intro e 1º trecho terminam
      await t.ate(() => !guided);
      await t.wait(300);
      return { parou: !guided, tocadas: tocadas.length, erro: [...document.querySelectorAll('#log > *')].some(x => /explicação parada/.test(x.textContent)) };
    } finally { HTMLMediaElement.prototype.play = playAntes; window.fetch = fetchAntes; config.voz = vozAntes; vozCache.clear(); }
  });
  assert.deepEqual(v, { parou: true, tocadas: 2, erro: true });
  console.log('✓ voz falhou no 2º trecho: a explicação para inteira em vez de pular o trecho');
  console.log('\nTudo certo.');
} catch (e) { failed = true; console.error('✗', e.message); }
finally { await browser.close(); server.kill(); process.exit(failed ? 1 : 0); }
