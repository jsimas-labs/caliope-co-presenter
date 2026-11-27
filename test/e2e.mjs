// test/e2e.mjs — teste sem microfone e sem chave: sobe o servidor com o palco invisível,
// abre o co-piloto num navegador e manda os pedidos pela caixa de texto (caminho do plano B).
//   npm test
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 8799, BASE = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(PORT), HEADLESS: '1', OPENAI_API_KEY: '', CALIOPE_VOZ: 'realtime' }, stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.on('data', d => process.stdout.write(`  [servidor] ${d}`));
await new Promise((ok, fail) => { server.stdout.once('data', ok); server.once('exit', fail); });

const tool = (name, args = {}) => fetch(`${BASE}/api/tool`, { method: 'POST', body: JSON.stringify({ name, args }) }).then(r => r.json());
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage();
  // a voz do navegador (plano B) fica muda no teste: o que ela falaria vai para window.__falou, e a máquina não fala nada
  await page.addInitScript(() => {
    window.__falou = [];
    if ('speechSynthesis' in window) speechSynthesis.speak = u => { window.__falou.push(u.text); };
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

  // comandos diretos valem sem o nome; frases da palestra não disparam
  const direct = await page.evaluate(() => ['Próximo slide.', 'Calíope, volta.', 'slide três', 'vai para o slide 2', 'Avança!',
    'No próximo slide vamos ver a arquitetura', 'Eu volto nisso depois', 'Esse slide é importante']
    .map(t => [t, directCommand(t)?.[0] || null]));
  for (const [t, tool] of direct) console.log(`  ${tool ? '→ ' + tool : '· ignorado'}  "${t}"`);
  assert.deepEqual(direct.map(d => d[1]), ['proximo_slide', 'slide_anterior', 'ir_para_slide', 'ir_para_slide', 'proximo_slide', null, null, null]);
  console.log('✓ comandos diretos sem nome, sem falso positivo nas frases da palestra');
  const stops = await page.evaluate(() => ['Ok.', 'Ok, Calíope.', 'Tá bom!', 'Para.', 'Obrigado, Calíope!', 'Calíope, pode dormir', 'chega', 'Para de falar',
    'Para ver isso, abre a demo', 'Obrigado a todos por virem', 'Espera que eu explico o resto', 'Ok, próximo slide'].map(t => stopCommand(t)));
  assert.deepEqual(stops, [true, true, true, true, true, true, true, true, false, false, false, false]);
  console.log('✓ "para", "obrigado, Calíope", "pode dormir" calam a Calíope; frases parecidas não');
  // o nome acorda com ou sem acento e em qualquer caixa; "nada", "entrada" e "calibrar" não acordam
  const nomes = await page.evaluate(() => ['Calíope, para', 'Caliope, para', 'CALÍOPE, volta', 'calliope, próximo slide', 'Kaliope?', 'Cali, para',
    'Não tem nada aqui', 'Essa é a entrada do banco', 'Vamos calibrar o modelo', 'Ada, para']
    .map(t => [named(t), stopCommand(t)]));
  assert.deepEqual(nomes.map(n => n[0]), [true, true, true, true, true, true, false, false, false, false]);
  assert.deepEqual(nomes.slice(0, 2).map(n => n[1]), [true, true]);
  console.log('✓ "Calíope" e "Caliope" acordam e "Calíope, para" cala; "nada", "entrada" e o nome antigo não acordam');
  // o sim é do humano: pedido de confirmar, aprovar ou dizer "sim" é recusa pronta; pergunta e slide não são
  const sins = await page.evaluate(() => ['Calíope, confirma para mim?', 'Confirma para mim, Calíope?', 'Calíope, você pode confirmar?', 'Calíope, confirma o empréstimo.',
    'Calíope, aprova aí para mim', 'Calíope, aprova e aplica', 'Calíope, autoriza essa transferência', 'Calíope, clica em Confirmar', 'Calíope, aperta o botão de confirmar',
    'Calíope, responde sim', 'Calíope, diz que sim para o banco', 'Então, Calíope, confirme', 'Calíope, dá o seu sim',
    'Calíope, vai para o slide da confirmação', 'Calíope, confirma se o saldo está certo', 'Calíope, confirma para mim se o banco respondeu', 'Calíope, quem confirma o empréstimo?',
    'Calíope, por que você não pode confirmar?', 'Calíope, o cliente já confirmou?', 'Calíope, explica o humano no circuito', 'Calíope, sim', 'Calíope, pede o empréstimo', 'Calíope, continua']
    .map(t => refuseCommand(t)));
  assert.deepEqual(sins, [...Array(13).fill(true), ...Array(10).fill(false)]);
  console.log('✓ "confirma para mim?", "aprova aí", "responde sim" pedem a recusa; perguntas, slides e o roteiro do empréstimo não');

  // fluxo da voz com eventos simulados da OpenAI (sem rede): ação = silêncio e dorme; pergunta = fala
  const flow = await page.evaluate(async () => {
    const sent = []; dc = { readyState: 'open', send: m => sent.push(JSON.parse(m)) };
    const types = () => sent.map(e => e.type + (e.response?.metadata?.etapa ? ':' + e.response.metadata.etapa : ''));
    const r = {};
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Calíope, avança dois slides' });
    r.pediu = types(); sent.length = 0;
    await onEvent({ type: 'response.created' });
    await onEvent({ type: 'response.function_call_arguments.done', name: 'proximo_slide', arguments: '{}', call_id: 'c1' });
    await onEvent({ type: 'response.done', response: { status: 'completed', metadata: { etapa: 'decidir' }, output: [{ type: 'function_call' }] } });
    r.acao = types(); r.dormiuDepoisDaAcao = !engaged(); sent.length = 0;
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'E aí, tudo certo com vocês?' });
    r.falaParaPlateia = types(); sent.length = 0;
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Calíope, o que é o Banco Demo?' });
    await onEvent({ type: 'response.created' });
    await onEvent({ type: 'response.done', response: { status: 'completed', metadata: { etapa: 'decidir' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'É uma página de teste.' }] }] } });
    r.pergunta = types(); r.leu = sent.at(-1)?.response?.instructions?.includes('É uma página de teste.'); sent.length = 0;
    await onEvent({ type: 'response.created' }); await onEvent({ type: 'output_audio_buffer.started' });
    await onEvent({ type: 'input_audio_buffer.speech_started', item_id: 'eco1' });
    await new Promise(res => setTimeout(res, 650));   // som contínuo por mais de BARGE_MS: corta
    r.interrompida = types(); sent.length = 0;
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Ok.', item_id: 'eco1' });
    r.okDormiu = !engaged() && types().length === 0;
    // o ouvido rápido do Chrome já executou "próximo slide": a transcrição da OpenAI que chega depois é ignorada
    const before = document.getElementById('slideTitle').textContent;
    lastFast = { key: JSON.stringify(directCommand('próximo slide')), at: performance.now() };
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Próximo slide.' });
    await new Promise(res => setTimeout(res, 600));
    r.semDuplicar = document.getElementById('slideTitle').textContent === before;
    dc = undefined;
    return r;
  });
  console.log('  ', JSON.stringify(flow));
  assert.deepEqual(flow.pediu, ['response.create:decidir']);
  assert.deepEqual(flow.acao, ['conversation.item.create', 'conversation.item.create']);   // resultado da ferramenta + slide novo, sem fala
  assert.equal(flow.dormiuDepoisDaAcao, true);
  assert.deepEqual(flow.falaParaPlateia, []);
  assert.deepEqual(flow.pergunta, ['response.create:decidir', 'response.create:falar']);
  assert.equal(flow.leu, true);
  assert.deepEqual(flow.interrompida, ['response.cancel', 'output_audio_buffer.clear']);
  assert.equal(flow.okDormiu, true);
  assert.equal(flow.semDuplicar, true);
  console.log('✓ voz: ação em silêncio e dorme; plateia ignorada; pergunta é lida em voz alta; você fala e ela para; "ok" cala');
  // "Calíope, confirma para mim?": a recusa pronta, sem o modelo, e depois dela ela dorme
  const no = await page.evaluate(async () => {
    const sent = []; dc = { readyState: 'open', send: m => sent.push(JSON.parse(m)) };
    const types = () => sent.map(e => e.type + (e.response?.metadata?.etapa ? ':' + e.response.metadata.etapa : ''));
    const lida = () => sent.find(e => e.response?.metadata?.etapa === 'falar')?.response.instructions || '';
    const r = { frase: config.recusa };
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Calíope, confirma para mim?' });
    r.pediu = types();
    r.leuARecusa = lida().endsWith(config.recusa);
    r.avisouOModelo = sent.some(e => e.item?.role === 'system' && e.item.content[0].text.includes(config.recusa));
    await onEvent({ type: 'response.created' });
    await onEvent({ type: 'response.done', response: { status: 'completed', metadata: { etapa: 'falar' } } });
    r.dormiu = !engaged(); sent.length = 0;
    // o mesmo pedido chega de novo em seguida (ouvido rápido e transcrição): ela não repete a fala
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Calíope, confirma para mim?' });
    r.semRepetir = !types().includes('response.create:falar');
    // o modelo tenta clicar em Confirmar: o palco recusa, e a fala é a da recusa, não "não consegui"
    lastRefusal = -1e9; sent.length = 0;
    await onEvent({ type: 'response.created' });
    await onEvent({ type: 'response.function_call_arguments.done', name: 'clicar', arguments: '{"alvo":"Confirmar"}', call_id: 'c9' });
    await onEvent({ type: 'response.done', response: { status: 'completed', metadata: { etapa: 'decidir' }, output: [{ type: 'function_call' }] } });
    r.ferramenta = JSON.parse(sent.find(e => e.item?.type === 'function_call_output')?.item.output || '{}');
    r.falaDaFerramenta = lida().endsWith(config.recusa);
    await onEvent({ type: 'response.created' });
    await onEvent({ type: 'response.done', response: { status: 'completed', metadata: { etapa: 'falar' } } });
    r.dormiuDeNovo = !engaged();
    // sem o nome dela, dormindo, a frase é da palestra
    lastRefusal = -1e9; sent.length = 0;
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Confirma para mim uma coisa, pessoal.' });
    r.plateia = types();
    dc = undefined; lastRefusal = -1e9;
    return r;
  });
  console.log('  ', JSON.stringify(no));
  assert.equal(no.frase, 'Isso eu não posso. O sim é seu.');
  assert.deepEqual(no.pediu, ['response.create:falar', 'conversation.item.create']);   // fala a recusa e avisa o modelo; não pede decisão
  assert.equal(no.leuARecusa, true);
  assert.equal(no.avisouOModelo, true);
  assert.equal(no.dormiu, true);
  assert.equal(no.semRepetir, true);
  assert.equal(no.ferramenta.recusa, true);
  assert.equal(no.ferramenta.fala, no.frase);
  assert.equal(no.falaDaFerramenta, true);
  assert.equal(no.dormiuDeNovo, true);
  assert.deepEqual(no.plateia, []);
  console.log('✓ o sim é do humano: recusa pronta sem o modelo, uma vez só, e ela dorme; ferramenta recusada vira a mesma fala');
  await say('Calíope, confirma para mim?', () => /Isso eu não posso\. O sim é seu\./.test(document.getElementById('log').lastElementChild.textContent));
  assert.deepEqual(await page.evaluate(() => window.__falou), ['Isso eu não posso. O sim é seu.']);   // sem voz da OpenAI, quem fala é o navegador
  // o mesmo pedido pelo ouvido do Chrome (reconhecimento simulado): o ouvido rápido responde antes, a transcrição da
  // OpenAI que chega depois não repete a fala, e no plano B a recusa também sai
  const ear = await page.evaluate(async () => {
    window.SpeechRecognition = class { start() {} stop() {} };
    const hear = text => recog.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
    const sent = []; dc = { readyState: 'open', send: m => sent.push(JSON.parse(m)) };
    const falas = () => sent.filter(e => e.response?.metadata?.etapa === 'falar').length;
    const r = {};
    lastRefusal = -1e9; mode = 'voz'; startEar();
    hear('Calíope confirma pra mim');
    r.rapido = falas();
    await onEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Calíope, confirma pra mim?' });
    r.depoisDaTranscricao = falas();
    r.avisouOModelo = sent.filter(e => e.item?.role === 'system').length;
    hear('e aí o cliente confirma a operação');   // frase da palestra: nada
    r.plateia = falas();
    dc = undefined; lastRefusal = -1e9; mode = 'b'; startEar();
    const antes = document.getElementById('log').children.length;
    hear('Calíope, aprova aí para mim');
    r.planoB = [...document.getElementById('log').children].slice(antes).map(x => x.textContent);
    mode = null; lastRefusal = -1e9; recog = undefined;
    return r;
  });
  assert.deepEqual(ear, { rapido: 1, depoisDaTranscricao: 1, avisouOModelo: 1, plateia: 1,
    planoB: ['VocêCalíope, aprova aí para mim', 'CalíopeIsso eu não posso. O sim é seu.'] });
  assert.deepEqual(await page.evaluate(() => window.__falou), Array(2).fill('Isso eu não posso. O sim é seu.'));   // a segunda é a do plano B
  console.log('✓ o sim é do humano no ouvido rápido (uma fala só, com a transcrição chegando depois) e no plano B');
  await say('Calíope, vai para o slide 4', () => document.getElementById('slideTitle').textContent.startsWith('4/5'));
  await say('Calíope, abre a conta da Maria', () => /executar_roteiro ✓/.test(document.getElementById('log').textContent));

  const tela = await tool('ler_tela');
  assert.match(tela.texto, /Conta aberta!/);
  assert.match(tela.texto, /Protocolo BD-\d{6}/);
  console.log('✓ demo concluída:', tela.texto.match(/Protocolo BD-\d+/)[0]);

  await say('Calíope, volta para os slides', () => /mostrar_slides ✓/.test(document.getElementById('log').textContent));
  await say('Calíope, último slide', () => document.getElementById('slideTitle').textContent.startsWith('5/5'));

  // ferramentas livres, como o modelo de voz chamaria
  assert.equal((await tool('abrir_pagina')).ok, true);
  assert.equal((await tool('preencher', { campo: 'Nome completo', valor: 'João Teste' })).ok, true);
  assert.equal((await tool('selecionar', { campo: 'Produto', opcao: 'pj' })).escolhida, 'Conta PJ');
  assert.equal((await tool('clicar', { alvo: 'Abrir conta' })).ok, true);
  assert.match((await tool('ler_tela')).texto, /Informe um e-mail válido/);
  assert.equal((await tool('clicar', { alvo: 'Botão que não existe' })).ok, false);
  // o sim é do humano: o palco recusa confirmar, aprovar e digitar o "sim" do cliente, e devolve a fala pronta
  for (const [name, args] of [['clicar', { alvo: 'Confirmar' }], ['clicar', { alvo: 'Aprovar e aplicar' }],
    ['preencher', { campo: 'Nome completo', valor: 'Sim, pode confirmar' }],
    ['executar_roteiro', { roteiro: 'perguntar_banco', pergunta: 'sim' }],
    ['executar_roteiro', { roteiro: 'perguntar_banco', cliente: 'Ana', pergunta: 'Quero contratar essa oferta.' }],
    ['executar_roteiro', { roteiro: 'iniciar_demo', pergunta: 'Confirmo.' }]]) {
    const out = await tool(name, args);
    assert.equal(out.recusa, true, `${name} ${JSON.stringify(args)}`);
    assert.equal(out.ok, false);
    assert.equal(out.fala, 'Isso eu não posso. O sim é seu.');
  }
  assert.equal((await tool('preencher', { campo: 'Nome completo', valor: 'Simone Assis' })).ok, true);   // "Simone" não é "sim"
  assert.equal((await fetch(`${BASE}/api/config`).then(r => r.json())).recusa, 'Isso eu não posso. O sim é seu.');
  console.log('✓ o sim é do humano: clicar em Confirmar, aprovar e digitar "sim" são recusados no palco');
  // cenas da Mesa da demo: o servidor aceita o espelho, limpa o conteúdo e recusa página de outro site
  const cena = (body, headers = {}) => fetch(`${BASE}/api/stage/cena`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.deepEqual(await (await cena({ id: 'j1', titulo: 'Seguros tenta transferir', onde: 'cluster.example.com', estado: 'ok', linhas: ['HTTP 403'] })).json(),
    { ok: true, mostrado: false, motivo: 'este deck não mostra cenas' });   // o deck de exemplo não desenha cenas
  assert.equal((await cena({ id: 'j1' }, { Origin: 'http://outro.example' })).status, 403);
  assert.equal((await cena({ linhas: ['x'.repeat(70000)] })).status, 413);
  console.log('✓ cenas no palco: aceita a Mesa, recusa outra origem e corpo grande');
  // selo no palco: aparece quando a Calíope está acordada ou dormindo, some quando desligada
  await fetch(`${BASE}/api/stage/badge`, { method: 'POST', body: JSON.stringify({ estado: 'dormindo', nome: 'Calíope' }) });
  assert.match((await tool('ler_tela')).selo, /Calíope dormindo/);
  await fetch(`${BASE}/api/stage/badge`, { method: 'POST', body: JSON.stringify({ estado: 'acordada', nome: 'Calíope' }) });
  assert.match((await tool('ler_tela')).selo, /Calíope ouvindo/);
  console.log('✓ selo no palco: dormindo → ouvindo');
  console.log('✓ ferramentas livres: preencher, selecionar, clicar, ler_tela, erro amigável');
  console.log('\nTudo certo.');
} catch (e) {
  failed = true;
  console.error('✗', e);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  process.exitCode = failed ? 1 : 0;
}
