// test/guide.mjs — long guided explanation, no microphone and no key (Nov 15 rule):
// each part ends only at the real end of its audio, none is cut or skipped, nothing advances by time,
// and only "<name>, stop" (or "para") or Esc stop the whole sequence.
//   npm test
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 8798, BASE = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(PORT), HEADLESS: '1', OPENAI_API_KEY: '', CALIOPE_VOICE: 'realtime', DECK_URL: `${BASE}/deck/guide.html` },
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
  // helpers inside the panel: the OpenAI session is a fake channel that keeps what the panel sends
  await page.evaluate(() => {
    window.__t = {
      wait: ms => new Promise(r => setTimeout(r, ms)),
      reset() { this.sent = []; dc = { readyState: 'open', send: m => this.sent.push(JSON.parse(m)) }; },
      lines() { return this.sent.filter(e => e.response?.metadata?.stage === 'speak').map(e => e.response.instructions.split('\n').at(-1)); },
      async until(cond, ms = 3000) { const t0 = performance.now(); while (!cond()) { if (performance.now() - t0 > ms) return -1; await this.wait(5); } return performance.now() - t0; },
    };
  });

  // 1) the whole explanation: intro + 5 parts with a line; steps 4, 5 and 8 have none
  const r = await page.evaluate(async () => {
    const t = window.__t; t.reset();
    startGuided(await runTool('explain_slide', {}));
    const lag = [];
    for (let k = 0; k < 6; k++) {
      if (await t.until(() => t.lines().length === k + 1) < 0) return { error: `part ${k} did not start`, lines: t.lines() };
      await onEvent({ type: 'output_audio_buffer.started' });
      await t.wait(1500);                          // a "long" part: without the end of the audio, nothing advances
      sayAloud('new speech over it');              // does not get in nor cut
      await onEvent({ type: 'input_audio_buffer.speech_started', item_id: 'echo' + k });   // echo or noise: does not cut
      await onEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'echo' + k, transcript: 'nothing to do with the bank entrance' });
      if (t.lines().length !== k + 1) return { error: `advanced without the end of the audio on part ${k}`, lines: t.lines() };
      await onEvent({ type: 'output_audio_buffer.stopped' });
      await onEvent({ type: 'output_audio_buffer.stopped' });   // a duplicate end does not skip a part
      if (k < 5) lag.push(await t.until(() => t.lines().length === k + 2));
    }
    await t.until(() => !guided);
    return { lines: t.lines(), lag, guidedAtEnd: !!guided, cuts: t.sent.filter(e => e.type === 'response.cancel' || e.type === 'output_audio_buffer.clear').length };
  });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(r.lines.map(f => f.split('.')[0]), ['I will explain the Agent Card in eight steps', 'Step one', 'Step two', 'Step three', 'Step six', 'Step seven']);
  assert.ok(r.lines[5].endsWith('looks on stage.'));
  assert.ok(!r.lines.includes('new speech over it'));
  assert.equal(r.cuts, 0);
  assert.equal(r.guidedAtEnd, false);
  // all 8 steps lit up, one at a time (the test deck ignores ←: this only reads the state)
  assert.equal((await page.evaluate(() => runTool('previous_slide', {}))).slide?.step, 8);
  // no timer: there used to be 450 ms after each end of audio plus 1.5 s per step without a line; the next part
  // now starts right after the end of the audio, also after steps 4 and 5 that have no line
  assert.ok(r.lag.every(ms => ms >= 0 && ms < 440), `delay after the end of the audio: ${r.lag.map(Math.round)} ms`);
  console.log(`✓ long explanation: intro + 5 whole parts, in order, only at the real end of the audio (delay ${r.lag.map(Math.round).join('/')} ms)`);
  console.log('✓ steps without a line light up with the next one, no timer; echo, noise and new speech do not cut');

  // 2) "Calíope, stop", "Caliope, para", "Calíope, para" and Esc on the 4th part stop the current speech and the whole queue
  for (const how of ['Calíope, stop', 'Caliope, stop', 'Caliope, para', 'Calíope, para', 'Esc']) {
    const s = await page.evaluate(async how => {
      const t = window.__t; t.reset();
      startGuided(await runTool('explain_slide', {}));
      for (let k = 0; k < 3; k++) { await t.until(() => t.lines().length === k + 1); await onEvent({ type: 'output_audio_buffer.started' }); await onEvent({ type: 'output_audio_buffer.stopped' }); }
      await t.until(() => t.lines().length === 4); await onEvent({ type: 'output_audio_buffer.started' });
      if (how === 'Esc') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else {
        await onEvent({ type: 'input_audio_buffer.speech_started', item_id: 'p' });
        await onEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'p', transcript: how });
      }
      const n = t.lines().length;
      await onEvent({ type: 'output_audio_buffer.stopped' });
      await t.wait(500);
      return { stopped: !guided, noNewLines: t.lines().length === n, cleared: t.sent.some(e => e.type === 'output_audio_buffer.clear') };
    }, how);
    assert.deepEqual(s, { stopped: true, noNewLines: true, cleared: true }, how);
    console.log(`✓ "${how}" on the 4th part stops the current speech and the whole queue`);
  }

  // 3) native voice failing on a part: the whole explanation stops, the part is never skipped
  const v = await page.evaluate(async () => {
    const t = window.__t; t.reset();
    const voiceBefore = config.voice, fetchBefore = window.fetch;
    config.voice = 'Luciana'; voiceCache.clear();
    // the test server may not have say (macOS only): the audio comes ready-made, and part 2's fails
    window.fetch = (u, o) => !String(u).endsWith('/api/voice') ? fetchBefore(u, o)
      : Promise.resolve(/Step two/.test(o?.body || '') ? new Response('', { status: 500 }) : new Response(new Blob([new Uint8Array(44)], { type: 'audio/wav' })));
    const played = [];
    const playBefore = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { played.push(this); return Promise.resolve(); };
    try {
      startGuided(await runTool('explain_slide', {}));
      for (let k = 0; k < 2; k++) { await t.until(() => played.length === k + 1); played[k].onended(); }   // intro and part 1 end
      await t.until(() => !guided);
      await t.wait(300);
      return { stopped: !guided, played: played.length, logged: [...document.querySelectorAll('#log > *')].some(x => /explanation stopped/.test(x.textContent)) };
    } finally { HTMLMediaElement.prototype.play = playBefore; window.fetch = fetchBefore; config.voice = voiceBefore; voiceCache.clear(); }
  });
  assert.deepEqual(v, { stopped: true, played: 2, logged: true });
  console.log('✓ voice failed on part 2: the whole explanation stops instead of skipping the part');
  console.log('\nAll good.');
} catch (e) { failed = true; console.error('✗', e.message); }
finally { await browser.close(); server.kill(); process.exit(failed ? 1 : 0); }
