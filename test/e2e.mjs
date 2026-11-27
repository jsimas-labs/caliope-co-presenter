// test/e2e.mjs — test with no microphone and no key: starts the server with an invisible stage,
// opens the copilot in a browser and sends requests through the text box (the plan B path).
// The talk language is the default (pt-BR), so the fixed phrases are Portuguese; commands work in pt and en.
//   npm test
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 8799, BASE = `http://localhost:${PORT}`;
const REFUSAL = 'Isso eu não posso. O sim é seu.';
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(PORT), HEADLESS: '1', OPENAI_API_KEY: '', CALIOPE_VOICE: 'realtime', LANGUAGE: 'pt-BR' }, stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.on('data', d => process.stdout.write(`  [server] ${d}`));
await new Promise((ok, fail) => { server.stdout.once('data', ok); server.once('exit', fail); });

const tool = (name, args = {}) => fetch(`${BASE}/api/tool`, { method: 'POST', body: JSON.stringify({ name, args }) }).then(r => r.json());
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage();
  // the browser voice (plan B) is muted in the test: what it would say goes to window.__said, and the machine says nothing
  await page.addInitScript(() => {
    window.__said = [];
    if ('speechSynthesis' in window) speechSynthesis.speak = u => { window.__said.push(u.text); };
  });
  await page.goto(BASE);
  await page.click('#btnStage');
  await page.waitForFunction(() => document.getElementById('slideTitle').textContent.startsWith('1/5'));

  const say = async (text, until) => {
    await page.fill('#cmdText', text);
    await page.press('#cmdText', 'Enter');
    await page.waitForFunction(until, null, { timeout: 30000 });
    console.log(`✓ "${text}" → ${await page.textContent('#slideTitle')}`);
  };
  await say('Próximo slide.', () => document.getElementById('slideTitle').textContent.startsWith('2/5'));

  // direct commands work without the name, in pt and en; talk sentences do not fire them
  const direct = await page.evaluate(() => ['Próximo slide.', 'Calíope, volta.', 'slide três', 'vai para o slide 2', 'Avança!',
    'Next slide.', 'Calíope, go back.', 'slide three', 'go to slide 2', 'Next!',
    'No próximo slide vamos ver a arquitetura', 'Eu volto nisso depois', 'Esse slide é importante',
    'In the next slide we will see the architecture', "I'll go back to that later", 'This slide is important']
    .map(t => [t, directCommand(t)?.[0] || null]));
  for (const [t, name] of direct) console.log(`  ${name ? '→ ' + name : '· ignored'}  "${t}"`);
  assert.deepEqual(direct.map(d => d[1]), ['next_slide', 'previous_slide', 'go_to_slide', 'go_to_slide', 'next_slide',
    'next_slide', 'previous_slide', 'go_to_slide', 'go_to_slide', 'next_slide', null, null, null, null, null, null]);
  console.log('✓ direct commands without the name, pt and en, no false positive on talk sentences');
  const stops = await page.evaluate(() => ['Ok.', 'Ok, Calíope.', 'Tá bom!', 'Para.', 'Obrigado, Calíope!', 'Calíope, pode dormir', 'chega', 'Para de falar',
    'Stop.', 'Calíope, stop', 'Thanks, Calíope!', "That's enough", 'Stop talking',
    'Para ver isso, abre a demo', 'Obrigado a todos por virem', 'Espera que eu explico o resto', 'Ok, próximo slide',
    'Stop by the booth later', 'Thanks everyone for coming', 'Ok, next slide'].map(t => stopCommand(t)));
  assert.deepEqual(stops, [...Array(13).fill(true), ...Array(7).fill(false)]);
  console.log('✓ "para", "stop", "obrigado/thanks, Calíope" silence Calíope; similar sentences do not');
  // the name wakes her with or without accents, in any case; "nada", "entrada" and "calibrar" do not
  const names = await page.evaluate(() => ['Calíope, para', 'Caliope, para', 'Calíope, stop', 'CALÍOPE, volta', 'calliope, next slide', 'Kaliope?', 'Cali, para',
    'Não tem nada aqui', 'Essa é a entrada do banco', 'Vamos calibrar o modelo', 'Ada, para']
    .map(t => [named(t), stopCommand(t)]));
  assert.deepEqual(names.map(n => n[0]), [true, true, true, true, true, true, true, false, false, false, false]);
  assert.deepEqual(names.slice(0, 3).map(n => n[1]), [true, true, true]);
  console.log('✓ "Calíope" and "Caliope" wake her and "Calíope, para/stop" silences her; "nada", "entrada" and the old name do not');
  // the yes is human: a request to confirm, approve or say "yes" gets the ready refusal; questions and slides do not
  const yeses = await page.evaluate(() => ['Calíope, confirma para mim?', 'Confirma para mim, Calíope?', 'Calíope, você pode confirmar?', 'Calíope, confirma o empréstimo.',
    'Calíope, aprova aí para mim', 'Calíope, aprova e aplica', 'Calíope, autoriza essa transferência', 'Calíope, clica em Confirmar', 'Calíope, aperta o botão de confirmar',
    'Calíope, responde sim', 'Calíope, diz que sim para o banco', 'Então, Calíope, confirme', 'Calíope, dá o seu sim',
    'Calíope, confirm it for me', 'Calíope, can you approve this?', 'Calíope, click Confirm', 'Calíope, say yes', 'Calíope, authorize the transfer',
    'Calíope, vai para o slide da confirmação', 'Calíope, confirma se o saldo está certo', 'Calíope, confirma para mim se o banco respondeu', 'Calíope, quem confirma o empréstimo?',
    'Calíope, por que você não pode confirmar?', 'Calíope, o cliente já confirmou?', 'Calíope, explica o humano no circuito', 'Calíope, sim', 'Calíope, pede o empréstimo', 'Calíope, continua',
    'Calíope, confirm whether the balance is right', 'Calíope, who confirms the loan?', 'Calíope, go to the confirmation slide']
    .map(t => refuseCommand(t)));
  assert.deepEqual(yeses, [...Array(18).fill(true), ...Array(13).fill(false)]);
  console.log('✓ "confirma para mim?", "confirm it for me", "say yes" get the refusal; questions, slides and the loan script do not');

  // the voice flow with simulated OpenAI events (no network): action = silence and sleep; question = speech
  const flow = await page.evaluate(async () => {
    const sent = []; dc = { readyState: 'open', send: m => sent.push(JSON.parse(m)) };
    const types = () => sent.map(e => e.type + (e.response?.metadata?.stage ? ':' + e.response.metadata.stage : ''));
    const r = {};
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Calíope, avança dois slides' });
    r.asked = types(); sent.length = 0;
    await onEvent({ type: 'response.created' });
    await onEvent({ type: 'response.function_call_arguments.done', name: 'next_slide', arguments: '{}', call_id: 'c1' });
    await onEvent({ type: 'response.done', response: { status: 'completed', metadata: { stage: 'decide' }, output: [{ type: 'function_call' }] } });
    r.action = types(); r.sleptAfterAction = !engaged(); sent.length = 0;
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'E aí, tudo certo com vocês?' });
    r.toAudience = types(); sent.length = 0;
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Calíope, o que é o Demo Bank?' });
    await onEvent({ type: 'response.created' });
    await onEvent({ type: 'response.done', response: { status: 'completed', metadata: { stage: 'decide' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'É uma página de teste.' }] }] } });
    r.question = types(); r.read = sent.at(-1)?.response?.instructions?.includes('É uma página de teste.'); sent.length = 0;
    await onEvent({ type: 'response.created' }); await onEvent({ type: 'output_audio_buffer.started' });
    await onEvent({ type: 'input_audio_buffer.speech_started', item_id: 'echo1' });
    await new Promise(res => setTimeout(res, 650));   // continuous sound for more than BARGE_MS: cuts
    r.interrupted = types(); sent.length = 0;
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Ok.', item_id: 'echo1' });
    r.okSlept = !engaged() && types().length === 0;
    // Chrome's fast ear already ran "próximo slide": the OpenAI transcript that comes later is ignored
    const before = document.getElementById('slideTitle').textContent;
    lastFast = { key: JSON.stringify(directCommand('próximo slide')), at: performance.now() };
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Próximo slide.' });
    await new Promise(res => setTimeout(res, 600));
    r.noDuplicate = document.getElementById('slideTitle').textContent === before;
    dc = undefined;
    return r;
  });
  console.log('  ', JSON.stringify(flow));
  assert.deepEqual(flow.asked, ['response.create:decide']);
  assert.deepEqual(flow.action, ['conversation.item.create', 'conversation.item.create']);   // tool result + new slide, no speech
  assert.equal(flow.sleptAfterAction, true);
  assert.deepEqual(flow.toAudience, []);
  assert.deepEqual(flow.question, ['response.create:decide', 'response.create:speak']);
  assert.equal(flow.read, true);
  assert.deepEqual(flow.interrupted, ['response.cancel', 'output_audio_buffer.clear']);
  assert.equal(flow.okSlept, true);
  assert.equal(flow.noDuplicate, true);
  console.log('✓ voice: silent action and sleep; audience ignored; question read aloud; you talk and she stops; "ok" silences');
  // "Calíope, confirma para mim?": the ready refusal, without the model, and she sleeps after it
  const no = await page.evaluate(async () => {
    const sent = []; dc = { readyState: 'open', send: m => sent.push(JSON.parse(m)) };
    const types = () => sent.map(e => e.type + (e.response?.metadata?.stage ? ':' + e.response.metadata.stage : ''));
    const read = () => sent.find(e => e.response?.metadata?.stage === 'speak')?.response.instructions || '';
    const r = { line: config.refusal };
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Calíope, confirma para mim?' });
    r.asked = types();
    r.readRefusal = read().endsWith(config.refusal);
    r.toldModel = sent.some(e => e.item?.role === 'system' && e.item.content[0].text.includes(config.refusal));
    await onEvent({ type: 'response.created' });
    await onEvent({ type: 'response.done', response: { status: 'completed', metadata: { stage: 'speak' } } });
    r.slept = !engaged(); sent.length = 0;
    // the same request arrives again right after (fast ear and transcript): she does not repeat it
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Calíope, confirma para mim?' });
    r.noRepeat = !types().includes('response.create:speak');
    // the model tries to click Confirm: the stage refuses, and the line is the refusal, not "I couldn't"
    lastRefusal = -1e9; sent.length = 0;
    await onEvent({ type: 'response.created' });
    await onEvent({ type: 'response.function_call_arguments.done', name: 'click', arguments: '{"target":"Confirmar"}', call_id: 'c9' });
    await onEvent({ type: 'response.done', response: { status: 'completed', metadata: { stage: 'decide' }, output: [{ type: 'function_call' }] } });
    r.tool = JSON.parse(sent.find(e => e.item?.type === 'function_call_output')?.item.output || '{}');
    r.toolLine = read().endsWith(config.refusal);
    await onEvent({ type: 'response.created' });
    await onEvent({ type: 'response.done', response: { status: 'completed', metadata: { stage: 'speak' } } });
    r.sleptAgain = !engaged();
    // without her name, asleep, the sentence belongs to the talk
    lastRefusal = -1e9; sent.length = 0;
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Confirma para mim uma coisa, pessoal.' });
    r.audience = types();
    dc = undefined; lastRefusal = -1e9;
    return r;
  });
  console.log('  ', JSON.stringify(no));
  assert.equal(no.line, REFUSAL);
  assert.deepEqual(no.asked, ['response.create:speak', 'conversation.item.create']);   // says the refusal and tells the model; no decision asked
  assert.equal(no.readRefusal, true);
  assert.equal(no.toldModel, true);
  assert.equal(no.slept, true);
  assert.equal(no.noRepeat, true);
  assert.equal(no.tool.refused, true);
  assert.equal(no.tool.say, no.line);
  assert.equal(no.toolLine, true);
  assert.equal(no.sleptAgain, true);
  assert.deepEqual(no.audience, []);
  console.log('✓ the yes is human: ready refusal without the model, once, and she sleeps; a refused tool becomes the same line');
  await say('Calíope, confirma para mim?', expected => document.getElementById('log').lastElementChild.textContent.includes('O sim é seu.'));
  assert.deepEqual(await page.evaluate(() => window.__said), [REFUSAL]);   // without the OpenAI voice, the browser speaks
  // the same request through Chrome's ear (simulated recognition): the fast ear answers first, the OpenAI transcript
  // that comes later does not repeat it, and in plan B the refusal comes out too
  const ear = await page.evaluate(async () => {
    window.SpeechRecognition = class { start() {} stop() {} };
    const hear = text => recog.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
    const sent = []; dc = { readyState: 'open', send: m => sent.push(JSON.parse(m)) };
    const lines = () => sent.filter(e => e.response?.metadata?.stage === 'speak').length;
    const r = {};
    lastRefusal = -1e9; mode = 'voice'; startEar();
    hear('Calíope confirma pra mim');
    r.fast = lines();
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Calíope, confirma pra mim?' });
    r.afterTranscript = lines();
    r.toldModel = sent.filter(e => e.item?.role === 'system').length;
    hear('e aí o cliente confirma a operação');   // talk sentence: nothing
    r.audience = lines();
    dc = undefined; lastRefusal = -1e9; mode = 'b'; startEar();
    const before = document.getElementById('log').children.length;
    hear('Calíope, aprova aí para mim');
    r.planB = [...document.getElementById('log').children].slice(before).map(x => x.textContent);
    mode = null; lastRefusal = -1e9; recog = undefined;
    return r;
  });
  assert.deepEqual(ear, { fast: 1, afterTranscript: 1, toldModel: 1, audience: 1,
    planB: ['YouCalíope, aprova aí para mim', `Calíope${REFUSAL}`] });
  assert.deepEqual(await page.evaluate(() => window.__said), Array(2).fill(REFUSAL));   // the second one is plan B's
  console.log('✓ the yes is human on the fast ear (one utterance, with the transcript arriving later) and in plan B');
  await say('Calíope, vai para o slide 4', () => document.getElementById('slideTitle').textContent.startsWith('4/5'));
  await say('Calíope, open an account for Maria', () => /run_script ✓/.test(document.getElementById('log').textContent));

  const screen = await tool('read_screen');
  assert.match(screen.text, /Account open!/);
  assert.match(screen.text, /Reference DB-\d{6}/);
  console.log('✓ demo done:', screen.text.match(/Reference DB-\d+/)[0]);

  await say('Calíope, back to the slides', () => /show_slides ✓/.test(document.getElementById('log').textContent));
  await say('Calíope, último slide', () => document.getElementById('slideTitle').textContent.startsWith('5/5'));

  // free tools, as the voice model would call them
  assert.equal((await tool('open_page')).ok, true);
  assert.equal((await tool('fill', { field: 'Full name', value: 'John Test' })).ok, true);
  assert.equal((await tool('select', { field: 'Product', option: 'business' })).selected, 'Business account');
  assert.equal((await tool('click', { target: 'Open account' })).ok, true);
  assert.match((await tool('read_screen')).text, /Enter a valid email/);
  assert.equal((await tool('click', { target: 'Button that does not exist' })).ok, false);
  // the yes is human: the stage refuses to confirm, approve and type the customer's "yes", and returns the ready line
  for (const [name, args] of [['click', { target: 'Confirmar' }], ['click', { target: 'Approve and apply' }],
    ['fill', { field: 'Full name', value: 'Sim, pode confirmar' }], ['fill', { field: 'Full name', value: 'Yes, I confirm' }],
    ['run_script', { script: 'ask_bank', question: 'sim' }],
    ['run_script', { script: 'ask_bank', customer: 'Ana', question: 'Quero contratar essa oferta.' }],
    ['run_script', { script: 'start_demo', question: 'Confirmo.' }]]) {
    const out = await tool(name, args);
    assert.equal(out.refused, true, `${name} ${JSON.stringify(args)}`);
    assert.equal(out.ok, false);
    assert.equal(out.say, REFUSAL);
  }
  assert.equal((await tool('fill', { field: 'Full name', value: 'Simone Assis' })).ok, true);   // "Simone" is not "sim"
  assert.equal((await fetch(`${BASE}/api/config`).then(r => r.json())).refusal, REFUSAL);
  console.log('✓ the yes is human: clicking Confirm, approving and typing "yes" are refused on stage');
  // demo console scenes: the server accepts the mirror, cleans the content and refuses a page from another site
  const scene = (body, headers = {}) => fetch(`${BASE}/api/stage/cena`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.deepEqual(await (await scene({ id: 'j1', titulo: 'Seguros tenta transferir', onde: 'cluster.example.com', estado: 'ok', linhas: ['HTTP 403'] })).json(),
    { ok: true, shown: false, reason: 'this deck does not show scenes' });   // the sample deck does not draw scenes
  assert.equal((await scene({ id: 'j1' }, { Origin: 'http://other.example' })).status, 403);
  assert.equal((await scene({ linhas: ['x'.repeat(70000)] })).status, 413);
  console.log('✓ scenes on stage: accepts the console, refuses another origin and a large body');
  // stage badge: shows when Calíope is awake or asleep, in the talk language, and goes away when off
  await fetch(`${BASE}/api/stage/badge`, { method: 'POST', body: JSON.stringify({ state: 'asleep', name: 'Calíope' }) });
  assert.match((await tool('read_screen')).badge, /Calíope dormindo/);
  await fetch(`${BASE}/api/stage/badge`, { method: 'POST', body: JSON.stringify({ state: 'awake', name: 'Calíope' }) });
  assert.match((await tool('read_screen')).badge, /Calíope ouvindo/);
  console.log('✓ stage badge: asleep → listening');
  console.log('✓ free tools: fill, select, click, read_screen, friendly error');
  console.log('\nAll good.');
} catch (e) {
  failed = true;
  console.error('✗', e);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  process.exitCode = failed ? 1 : 0;
}
