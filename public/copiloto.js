/* copiloto.js — ouve o apresentador, conversa com a API de voz e chama as ferramentas do palco.
   Dois modos:
   - voz OpenAI (Realtime por WebRTC): entende pedidos livres, fala com voz natural, escolhe as ferramentas;
   - plano B (reconhecimento de voz do Chrome + comandos fixos): sem custo, para quando a API ou a rede falhar.
   O texto digitado na caixa de comando segue o mesmo caminho do modo ativo. */
'use strict';

const $ = id => document.getElementById(id);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok && j.erro) throw new Error(j.erro); return j; });

let config = { nome: 'Calíope' };
let mode = null;            // 'voz' | 'b' | null
let wanted = false;         // o apresentador quer a voz ligada: reconecta sozinho se a sessão cair
let pc, dc, mic, meterStop;
let pendingTools = [], needsFollowup = false;
let currentSlide = null;
let recog;

/* ==================== registro na tela ==================== */
function log(who, text, cls = '') {
  const el = document.createElement('div');
  el.className = cls || who.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  el.innerHTML = `<span class="who"></span><span class="txt"></span>`;
  el.querySelector('.who').textContent = who;
  el.querySelector('.txt').textContent = text;
  $('log').appendChild(el);
  if (/sistema|erro|acao|caliope/.test(el.className)) fetch('/api/log', { method: 'POST', body: JSON.stringify({ quem: who, texto: String(text).slice(0, 200) }) }).catch(() => {});
  $('log').scrollTop = $('log').scrollHeight;
  return el;
}
// tempo desde que você parou de falar: aparece no registro para achar onde está a lentidão
let tStop = 0;
const since = () => tStop ? ` · ${Math.round(performance.now() - tStop)} ms` : '';

function setStatus(text, cls = '') { $('status').textContent = text; $('status').className = 'pill ' + cls; }
function showSlide(s) {
  if (!s) return;
  currentSlide = s;
  $('slideTitle').textContent = s.numero ? `${s.numero}/${s.total} · ${s.titulo}` : s.titulo;
  $('slideInfo').textContent = s.notas || '';
}

/* ==================== quando a Calíope presta atenção ====================
   Três jeitos de falar com ela, do mais rápido ao mais livre:
   1. comando direto ("próximo slide", "volta", "slide 3"): executa na hora, sem nome e sem passar pelo modelo;
   2. pelo nome ("Calíope, ..."): abre uma janela de conversa;
   3. dentro da janela (padrão 30 s depois da última troca), qualquer fala vai para o modelo, que decide
      se é para ela ou para a plateia (ferramenta aguardar = silêncio). "Sempre atenta" deixa a janela aberta. */
// Com ou sem acento: "Calíope", "Caliope" e "CALÍOPE" acordam igual, venha a grafia do campo ou da transcrição.
const ACENTOS = { a: 'aáàâã', e: 'eéêè', i: 'iíîì', o: 'oóôõò', u: 'uúûùü', c: 'cç' };
const wakePattern = w => [...w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()]
  .map(ch => ACENTOS[ch] ? `[${ACENTOS[ch]}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
function wakeRegex() {
  const words = $('wake').value.split(',').map(w => w.trim()).filter(Boolean);
  if (!words.length) words.push(config.nome);
  return new RegExp(`(^|[^\\p{L}])(${words.map(wakePattern).join('|')})(?=$|[^\\p{L}])`, 'iu');
}
const named = text => wakeRegex().test(text);

let engagedUntil = 0;
const engaged = () => $('openMode').checked || Date.now() < engagedUntil;
function engage() { engagedUntil = Date.now() + Number($('windowSec').value || 30) * 1000; }
// acordada = ouve qualquer fala; dormindo = só o nome ou um comando direto. Mostra no painel e,
// se marcado, num selo discreto na janela do palco (avisa o servidor só quando o estado muda)
let lastBadge = '';
setInterval(() => {
  const left = Math.ceil((engagedUntil - Date.now()) / 1000);
  const state = !mode ? 'off' : $('openMode').checked || left > 0 ? 'acordada' : 'dormindo';
  const mood = $('mood');
  mood.className = 'mood ' + state;
  mood.querySelector('b').textContent = state === 'off' ? 'Desligada' : state === 'acordada' ? 'Ouvindo' : 'Dormindo';
  mood.querySelector('span').textContent = state === 'off' ? 'conecte a voz para começar'
    : $('openMode').checked ? 'sempre atenta, fale normalmente'
    : state === 'acordada' ? `fale normalmente · dorme em ${left}s`
    : `diga "${config.nome}" ou um comando direto`;
  if (mode === 'voz') setStatus(dc?.readyState === 'open' ? 'voz conectada' : 'conectando…', dc?.readyState === 'open' ? 'on' : 'wait');
  else if (mode === 'b') setStatus('plano B', 'wait');
  const badge = $('stageBadge').checked ? state : 'off';
  if (badge !== lastBadge) { lastBadge = badge; post('/api/stage/badge', { estado: badge, nome: config.nome }).catch(() => {}); }
}, 400);

const NUM = { um: 1, dois: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 };
const DIRECT = [
  [/^(?:(?:ok|entao|bora|agora)\s+)?(?:proxim[oa](?: slide)?|avanca(?: o slide)?|passa(?: o slide)?|slide seguinte|seguinte)$/, () => ['proximo_slide', {}]],
  [/^(?:(?:ok|entao)\s+)?(?:volta(?: um)?(?: o)?(?: slide)?|slide anterior|anterior)$/, () => ['slide_anterior', {}]],
  [/^(?:(?:vai|volta) (?:para|pro|pra) (?:o )?)?slide (\d+|um|dois|tres|quatro|cinco|seis|sete|oito|nove|dez)$/, m => ['ir_para_slide', { numero: NUM[m[1]] || Number(m[1]) }]],
  [/^(?:mostra|volta (?:para|pros|pra)) (?:os )?slides$/, () => ['mostrar_slides', {}]],
  [/^(?:mostra|volta (?:para|pra|pro)|vai (?:para|pra|pro)|vamos (?:para|pra|pro)) (?:a )?apresentacao$/, () => ['mostrar_aba', { aba: 'apresentacao' }]],
  [/^(?:vai|vamos|volta) (?:para|pra|pro) (?:a |o )?(?:demo|banco|agentic bank)$/, () => ['mostrar_aba', { aba: 'banco' }]],
  [/^(?:vai|vamos) (?:para|pra|pro) (?:o )?(?:sre panel|painel (?:do )?sre|sre)$/, () => ['mostrar_aba', { aba: 'sre' }]],
];
// "Calíope, próximo slide." → "proximo slide": sem nome, acento, pontuação e caixa
function directCommand(text) {
  const t = text.replace(wakeRegex(), ' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\d\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, make] of DIRECT) { const m = t.match(re); if (m) return make(m); }
  return null;
}

// "ok", "para", "chega", "obrigado, Calíope", "pode dormir": ela cala na hora e volta a dormir
const STOP = /^(?:(?:ok|ta|tudo bem)\s+)?(?:ok|okay|ok ok|ta bom|ta|certo|entendi|perfeito|para|pare|chega|silencio|quieta|pode parar|para de falar|obrigad[oa]|valeu|beleza|dorme|pode dormir|vai dormir|ja deu|espera|so um minuto)$/;
// Com a voz nativa, o ouvido rápido escuta a própria Calíope: uma palavra solta como "para" no meio da fala dela não
// pode calá-la. Enquanto ela fala, a parada por voz precisa do nome ("Calíope, para"); o Esc sempre vale.
const nativeVoice = () => config.voz && config.voz !== 'realtime';
const whileTalking = () => speaking || !!guided || performance.now() - caliopeQuietAt < ECHO_TAIL_MS;
const stopNow = text => stopCommand(text) && (!nativeVoice() || !whileTalking() || named(text));
const stopCommand = text => STOP.test(text.replace(wakeRegex(), ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^\p{L}\d\s]/gu, ' ').replace(/\s+/g, ' ').trim());

// "Calíope, confirma para mim?": o sim é do humano. Um pedido para confirmar, aprovar ou autorizar, dito com o nome
// dela, recebe a recusa pronta na hora, sem passar pelo modelo. Sem o nome, a frase segue o caminho normal: o modelo
// tem a mesma regra (agent.mjs) e o palco recusa a ferramenta (stage.mjs). "Confirma se o saldo está certo" é uma
// pergunta, não um pedido de sim, e também segue o caminho normal.
const REFUSE = new RegExp('^(?:(?:entao|agora|por favor|ok|ai|e ai|vai)\\s+)*'
  + '(?:(?:voce\\s+)?(?:pode|consegue|quer|poderia|da (?:para|pra)|tem como)\\s+)?(?:voce\\s+)?(?:'
  + '(?:confirm|aprov|autoriz)(?:a|e|ar)\\b(?!\\s+(?:(?:para|pra)\\s+(?:mim|a gente|nos)\\s+)?(?:se|que|qual|quais|quanto|quanta|quando|onde|como|quem)\\b)'
  + '|(?:clica|clicar|clique|aperta|apertar|aperte)\\s+(?:em\\s+|no\\s+botao\\s+(?:de\\s+)?|o\\s+botao\\s+(?:de\\s+)?|no\\s+|o\\s+)?(?:confirmar|aprovar|autorizar|sim)\\b'
  + '|(?:responde|responda|responder|diz|diga|dizer|fala|fale|falar|digita|digite|digitar|escreve|escreva|escrever|manda|mande|mandar)\\s+(?:que\\s+|um\\s+|o\\s+)?sim\\b'
  + '|da\\s+o\\s+(?:seu\\s+)?sim\\b)');
const refuseCommand = text => REFUSE.test(text.replace(wakeRegex(), ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^\p{L}\d\s]/gu, ' ').replace(/\s+/g, ' ').trim());
// A recusa é uma fala só, a mesma em todos os caminhos, e depois dela ela dorme: a próxima frase do Jonathan é para a
// plateia. O mesmo pedido pode chegar pelo ouvido rápido, pela transcrição e por uma ferramenta recusada: fala uma vez.
let lastRefusal = -1e9;
function refuse() {
  const now = performance.now();
  if (now - lastRefusal < 8000) return;
  lastRefusal = now;
  engagedUntil = 0;
  const fala = config.recusa || 'Isso eu não posso. O sim é seu.';
  if (nativeVoice() || dc?.readyState === 'open') sayAloud(fala, { dorme: true });
  else { log(config.nome, fala, 'caliope'); speak(fala); }   // plano B: a voz do navegador
}
// o modelo fica sabendo que o pedido já foi respondido: não age sobre ele depois, nem repete a frase
function noteRefusal() {
  send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text',
    text: `O Jonathan pediu para você confirmar ou aprovar uma operação, e você já respondeu em voz alta: "${config.recusa || ''}" `
      + 'Assunto encerrado: não confirme nada, não repita a frase e não comente.' }] } });
}

// o mesmo comando pode chegar duas vezes: primeiro pelo ouvido rápido do Chrome, depois pela transcrição da OpenAI
let lastFast = { key: '', at: 0 };
function already(key) {
  if (lastFast.key === key && performance.now() - lastFast.at < 5000) { lastFast = { key: '', at: 0 }; return true; }
  return false;
}

async function runDirect([tool, args]) {
  const out = await runTool(tool, args);
  sendSlideContext();   // o modelo fica sabendo do slide novo sem falar nada
  return out;
}

/* ==================== ferramentas (iguais nos dois modos) ==================== */
async function runTool(name, args) {
  const line = log('Ação', `${name} ${Object.keys(args).length ? JSON.stringify(args) : ''}…`, 'acao');
  try {
    const out = await post('/api/tool', { name, args });
    line.querySelector('.txt').textContent = `${name} ${out.ok ? '✓' : out.recusa ? '∅ recusou: o sim é do humano' : '✗ ' + out.erro}${since()}`;
    if (!out.ok && !out.recusa) line.className = 'erro';
    if (out.slide) showSlide(out.slide);
    return out;
  } catch (e) {
    line.className = 'erro';
    line.querySelector('.txt').textContent = `${name} ✗ ${e.message}`;
    return { ok: false, erro: e.message };
  }
}

/* ==================== áudio: dispositivos, saída e medidor ==================== */
async function listDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind) => {
    const keep = sel.value;
    sel.innerHTML = '';
    for (const d of devs.filter(d => d.kind === kind)) sel.add(new Option(d.label || `${kind} ${sel.length + 1}`, d.deviceId));
    if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
    else { const bh = [...sel.options].find(o => /blackhole/i.test(o.text)); if (bh && kind === 'audiooutput') sel.value = bh.value; }
  };
  fill($('micSel'), 'audioinput');
  fill($('outSel'), 'audiooutput');
}

async function routeOutput() {
  // a voz vai para a saída escolhida (BlackHole → Meet) e, se pedido, também para o dispositivo padrão (seu fone)
  const out = $('audioOut'), mon = $('audioMon');
  try { if (out.setSinkId) await out.setSinkId($('outSel').value || ''); } catch (e) { log('Erro', `saída de áudio: ${e.message}`); }
  const sameAsDefault = !$('outSel').value || $('outSel').value === 'default';
  mon.muted = !$('monitor').checked || sameAsDefault;
}

function startMeter(stream) {
  const ctx = new AudioContext(), an = ctx.createAnalyser(), buf = new Uint8Array(256);
  ctx.createMediaStreamSource(stream).connect(an);
  let alive = true;
  (function tick() {
    if (!alive) return;
    an.getByteTimeDomainData(buf);
    let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    $('meter').firstElementChild.style.width = Math.min(100, peak * 1.6) + '%';
    requestAnimationFrame(tick);
  })();
  return () => { alive = false; ctx.close(); };
}

async function openMic() {
  mic = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: $('micSel').value ? { exact: $('micSel').value } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  mic.getAudioTracks()[0].enabled = !$('muted').checked;
  meterStop?.(); meterStop = startMeter(mic);
  await listDevices();   // depois da permissão os nomes dos dispositivos aparecem
}

/* ==================== modo voz: OpenAI Realtime por WebRTC ==================== */
const send = ev => { if (dc?.readyState === 'open') dc.send(JSON.stringify(ev)); };

function sendSlideContext() {
  if (!currentSlide) return;
  send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text',
    text: `Slide atual ${currentSlide.numero || ''}/${currentSlide.total || ''}: "${currentSlide.titulo}". Notas: ${currentSlide.notas || '(sem notas)'}` }] } });
}

async function connectVoice() {
  setStatus('conectando…', 'wait');
  const { key, model } = await post('/api/session');
  pc = new RTCPeerConnection();
  pc.ontrack = e => { $('audioOut').srcObject = e.streams[0]; $('audioMon').srcObject = e.streams[0]; routeOutput(); };
  if (!mic) await openMic();
  pc.addTrack(mic.getAudioTracks()[0], mic);
  dc = pc.createDataChannel('oai-events');
  dc.onopen = () => { setStatus(`ouvindo · ${config.nome}`, 'on'); log('Sistema', `voz conectada (${model})`, 'sistema'); sendSlideContext(); };
  dc.onmessage = e => onEvent(JSON.parse(e.data));
  dc.onclose = () => dropped('canal de eventos fechou');
  pc.onconnectionstatechange = () => { if (pc && ['failed', 'closed'].includes(pc.connectionState)) dropped(`conexão ${pc.connectionState}`); };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const r = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
    method: 'POST', body: offer.sdp, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/sdp' },
  });
  if (!r.ok) throw new Error(`OpenAI recusou a conexão (${r.status}): ${(await r.text()).slice(0, 200)}`);
  await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
}

let reconnecting = false;
async function dropped(why) {
  if (!wanted || mode !== 'voz' || reconnecting) return;
  reconnecting = true;
  log('Sistema', `${why}; reconectando…`, 'sistema');
  teardownVoice();
  for (let i = 0; wanted && i < 5; i++) {
    try { await connectVoice(); break; }
    catch (e) { log('Erro', e.message); await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  reconnecting = false;
}

function teardownVoice() {
  try { dc?.close(); } catch {}
  try { pc?.close(); } catch {}
  dc = pc = undefined;
}

/* ---------- pensar em silêncio, falar só quando for resposta ----------
   Todo pedido vira primeiro uma resposta só de texto (sem som). Se o modelo chamou ferramentas, elas rodam
   em silêncio e a Calíope volta a dormir: só fala de novo quando você a chamar. Se o modelo respondeu com texto
   (uma pergunta, uma explicação), um segundo passo lê esse texto em voz alta. Assim ela nunca narra ações. */
let responding = false, speaking = false, interrupted = false;
const BARGE_MS = 500;   // quanto som contínuo corta a fala dela
let bargeTimer = 0;
const duringCaliope = new Set();   // falas que começaram enquanto ela falava
// A voz dela sai por alto-falante e volta pelo microfone. Três defesas para ela não responder a si mesma:
// 1) fala que começa enquanto ela fala (ou até ECHO_TAIL_MS depois) é eco; 2) transcrição parecida com algo
// que ela acabou de dizer é eco, mas só enquanto ela fala ou até ECHO_TEXT_MS depois (a transcrição chega atrasada);
// 3) depois de uma explicação guiada ela dorme.
// Regra (15/11): com ela calada, a sua fala nunca é eco. Antes, o critério 2 valia por 90 s e "pensando" (responding,
// sem som saindo) também marcava eco: depois de uma explicação longa, quase tudo o que o Jonathan dizia sobre o mesmo
// assunto era descartado.
const ECHO_TAIL_MS = 1500, ECHO_TEXT_MS = 4000;
let caliopeQuietAt = -1e9;
const spoken = [];   // { words:Set, at }
const wordsOf = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
function remember(text) { spoken.push({ words: new Set(wordsOf(text)), at: performance.now() }); if (spoken.length > 30) spoken.shift(); }
function soundsLikeMe(text) {
  const w = wordsOf(text);
  if (w.length < 2) return false;
  const now = performance.now();
  if (!speaking && !guided && now - caliopeQuietAt > ECHO_TEXT_MS) return false;   // calada: nunca é eco
  return spoken.some(s => now - s.at < 90000 && w.filter(x => s.words.has(x)).length / w.length >= 0.6);
}
const ANSWER_AFTER = new Set(['ler_tela']);   // ferramentas de consulta: depois delas ela responde a pergunta
let toolResults = [];

const think = () => send({ type: 'response.create', response: { output_modalities: ['text'], metadata: { etapa: 'decidir' } } });
// Explicação guiada: cada trecho só termina no fim REAL do áudio (output_audio_buffer.stopped, que vem do "ended" do
// áudio nativo ou do fim do áudio da OpenAI); só então o passo avança e o próximo trecho começa. Nenhuma outra fala
// entra por cima enquanto ela explica: só "para" ou Esc (hush) param a sequência inteira.
let sleepAfterSpeech = false;   // dorme: depois desta fala ela não fica acordada esperando a continuação
function sayAloud(text, { guia = false, dorme = false } = {}) {
  if (guided && !guia) { log(config.nome, `(explicando: não falo por cima) ${text}`, 'sistema'); return; }
  remember(text);
  if (!config.voz || config.voz === 'realtime') {
    sleepAfterSpeech = dorme;
    send({ type: 'response.create', response: {
      conversation: 'none', output_modalities: ['audio'], metadata: { etapa: 'falar' },
      // o teto da sessão (800 tokens, ~30 s) cortava os trechos longos da explicação guiada no meio
      max_output_tokens: 'inf',
      instructions: `${config.estiloVoz || ''}\nLeia em voz alta exatamente o texto abaixo, sem acrescentar nem tirar nada:\n${text}`,
    } });
    return;
  }
  sayNative(text, dorme);
}

/* espectro: barras animadas por cima do palco e deste painel só enquanto ela fala, ligadas ao estado "falando" (animação sintética).
   O painel não toca nem decodifica o áudio para isso: a voz sai exatamente como antes. Ver public/espectro.js. */
let espectroLigado = false;
function espectro(msg) {   // isolado: nada aqui pode afetar a fala ou a escuta
  try {
    if (msg.acao !== 'parar' && !$('espectro')?.checked) return;
    if (msg.acao === 'parar' && !espectroLigado) return;
    espectroLigado = msg.acao !== 'parar';
    window.__caliEspectro?.cmd(msg);   // aqui no painel também (só 5 barras em CSS; nada de áudio)
    post('/api/stage/espectro', { nome: config.nome, ...msg }).catch(() => {});
  } catch {}
}
/* voz nativa pt-BR (macOS): o servidor gera o áudio e ele sai pelos mesmos dispositivos da voz da OpenAI.
   Os mesmos estados (speaking, explicação guiada, "para") valem aqui. */
let nativeAudio = [];
// Com a voz nativa o navegador não cancela o eco. Enquanto ela fala (e na explicação guiada inteira), o microfone
// que vai para a OpenAI fica fechado: o modelo nunca ouve a voz dela. "Para" continua valendo pelo ouvido rápido
// do Chrome e pelo Esc.
let deafTimer = 0;
function deaf(on) {
  clearTimeout(deafTimer);
  const t = mic?.getAudioTracks()[0];
  if (!t) return;
  if (on) { t.enabled = false; return; }
  deafTimer = setTimeout(() => { if (!speaking && !guided) t.enabled = !$('muted').checked; }, 900);
}
async function sayNative(text, quiet = false) {
  remember(text);
  nativeAudio.forEach(a => { a.onended = null; a.pause(); });   // nunca duas falas por cima
  deaf(true);
  const myTurn = ++nativeTurn;
  let blob;
  try {
    blob = await vozBlob(text);
  } catch (e) {
    log('Erro', `voz: ${e.message}`);
    // na explicação guiada, um trecho sem áudio não é pulado: a explicação para inteira e ela volta a dormir
    if (guided) { guided = null; deaf(false); engagedUntil = 0; caliopeQuietAt = performance.now(); log(config.nome, '(explicação parada: a voz falhou neste trecho)', 'sistema'); }
    return;
  }
  if (myTurn !== nativeTurn) return;   // cortada enquanto o áudio era gerado
  const url = URL.createObjectURL(blob);
  const main = new Audio(url), mon = new Audio(url);
  try { if (main.setSinkId) await main.setSinkId($('outSel').value || ''); } catch {}
  const sameAsDefault = !$('outSel').value || $('outSel').value === 'default';
  nativeAudio = [main].concat($('monitor').checked && !sameAsDefault ? [mon] : []);
  main.onended = () => {
    if (myTurn !== nativeTurn) return;
    URL.revokeObjectURL(url);
    nativeAudio = [];
    onEvent({ type: 'output_audio_buffer.stopped' });
    deaf(false);
    if (!guided && !quiet) engage();   // acabou de responder: fica acordada para a continuação
  };
  log(config.nome, text, 'caliope');
  onEvent({ type: 'output_audio_buffer.started' });
  nativeAudio.forEach(a => a.play().catch(e => log('Erro', `voz: ${e.message}`)));
}
let nativeTurn = 0;
// áudio pedido antes da hora (explicação guiada): cada parte já está pronta quando a anterior termina
const vozCache = new Map();
function vozBlob(text) {
  if (!vozCache.has(text)) {
    vozCache.set(text, fetch('/api/voz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto: text, voz: config.voz }) })
      .then(r => { if (!r.ok) throw new Error(`voz respondeu ${r.status}`); return r.blob(); })
      .catch(e => { vozCache.delete(text); throw e; }));
    if (vozCache.size > 40) vozCache.delete(vozCache.keys().next().value);
  }
  return vozCache.get(text);
}
function stopNative() {
  nativeTurn++;
  setTimeout(() => deaf(false), 0);
  nativeAudio.forEach(a => { a.pause(); a.src = ''; });
  nativeAudio = [];
}

/* ---------- explicação guiada (explicar_slide) ----------
   O deck traz uma fala pronta para cada passo do slide. Ela acende o passo, lê a fala, espera o áudio
   terminar (evento de fim real do áudio) e passa para o próximo. Só "para" ou Esc interrompem; ela volta a dormir. */
let guided = null;
function startGuided(out) {
  guided = { partes: out.partes || [], i: -1 };
  log(config.nome, `(explicando o slide em ${guided.partes.length} partes)`, 'sistema');
  if (config.voz && config.voz !== 'realtime') [out.intro, ...guided.partes].filter(Boolean).forEach(t => vozBlob(t).catch(() => {}));
  if (out.intro) { guided.falando = -1; sayAloud(out.intro, { guia: true }); } else guidedNext();
}
// Sem timers (regra de 15/11): o próximo passo só vem do fim real do áudio do trecho anterior. Um passo sem fala
// acende junto com o seguinte, na mesma hora, e a fala do seguinte começa logo depois.
async function guidedNext() {
  while (guided) {
    const g = guided;
    g.i++;
    if (g.i >= g.partes.length) { guided = null; deaf(false); engagedUntil = 0; caliopeQuietAt = performance.now(); log(config.nome, '(fim da explicação, dormindo)', 'sistema'); return; }
    await runTool('proximo_slide', {});
    if (guided !== g) return;
    const fala = g.partes[g.i];
    if (fala) { g.falando = g.i; sayAloud(fala, { guia: true }); return; }
  }
}

function hush(why) {
  guided = null;
  stopNative();
  if ('speechSynthesis' in window) speechSynthesis.cancel();   // plano B
  if (responding) send({ type: 'response.cancel' });
  if (speaking || responding) send({ type: 'output_audio_buffer.clear' });   // corta o áudio que já estava saindo
  needsFollowup = false; pendingTools = []; toolResults = [];
  if (responding || speaking) log(config.nome, `(${why})`, 'sistema');
  responding = speaking = false;
  espectro({ acao: 'parar' });
}

async function onEvent(ev) {
  switch (ev.type) {
    case 'response.created': responding = true; break;
    case 'output_audio_buffer.started': speaking = true; espectro({ acao: 'sintetico' }); log('Sistema', `começou a falar${since()}`, 'sistema'); break;
    case 'input_audio_buffer.speech_stopped': tStop = performance.now(); clearTimeout(bargeTimer); break;
    case 'output_audio_buffer.stopped':
      speaking = false; caliopeQuietAt = performance.now(); espectro({ acao: 'parar' });
      // terminou o áudio de um trecho da explicação guiada: o próximo começa já (um avanço por trecho, nunca dois)
      if (guided && guided.falando === guided.i) { guided.falando = null; guidedNext(); }
      break;
    case 'output_audio_buffer.cleared': speaking = false; espectro({ acao: 'parar' }); break;
    case 'input_audio_buffer.speech_started':
      // som no microfone enquanto ela fala: pode ser você, pode ser a voz dela voltando pela sala, pode ser barulho.
      // Essa fala fica marcada: a transcrição dela só vale se for "para", "ok", "chega"...
      if (speaking || guided || performance.now() - caliopeQuietAt < ECHO_TAIL_MS) duringCaliope.add(ev.item_id);   // pensando (responding) não sai som: não é eco
      // na explicação guiada ela não para por qualquer som: só pela palavra de parada ou pelo Esc
      if (guided) break;
      // fora dela, para só se o som durar BARGE_MS (tosse, porta e eco curto não cortam)
      if ((speaking || responding) && $('bargeIn').checked) {
        clearTimeout(bargeTimer);
        bargeTimer = setTimeout(() => { if (speaking || responding) { interrupted = true; hush('interrompida'); } }, BARGE_MS);
      }
      break;
    case 'conversation.item.input_audio_transcription.completed': {
      const text = (ev.transcript || '').trim();
      if (!text) return;
      const echo = duringCaliope.delete(ev.item_id) || soundsLikeMe(text);
      if (echo && !stopNow(text)) {
        if (ev.item_id) send({ type: 'conversation.item.delete', item_id: ev.item_id });
        log('Você', `${text} (eco da fala dela: ignorado)`, 'voce ignored'); break; }
      if (stopNow(text)) {
        hush('parou'); engagedUntil = 0; interrupted = false;
        if (already('stop')) break;
        log('Você', text + since(), 'voce');
        log(config.nome, '(dormindo)', 'sistema');
        break;
      }
      if (named(text) && refuseCommand(text)) {   // "confirma para mim?": a recusa pronta, sem o modelo
        interrupted = false;
        if (!already('recusa')) { log('Você', text + since(), 'voce'); refuse(); }
        noteRefusal();
        break;
      }
      const direct = directCommand(text);
      // a fala que a interrompeu só vira pedido se tiver o nome dela
      const go = !direct && (named(text) || (engaged() && !interrupted));
      interrupted = false;
      if (direct && already(JSON.stringify(direct))) break;   // o Chrome já executou
      log('Você', text + since(), direct || go ? 'voce' : 'voce ignored');
      if (direct) { runDirect(direct); break; }
      if (named(text)) engage();
      if (go) think();
      break;
    }
    case 'response.function_call_arguments.done': {
      if (ev.name === 'aguardar') {   // não era com ela: fica quieta, sem resposta de acompanhamento
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: '{"ok":true}' } });
        log(config.nome, '(não era comigo, aguardando)', 'sistema');
        break;
      }
      if (ev.name === 'explicar_slide' && guided) {   // já está explicando: não recomeça
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: '{"ok":true,"nota":"já estou explicando"}' } });
        break;
      }
      const p = (async () => {
        let args = {};
        try { args = JSON.parse(ev.arguments || '{}'); } catch {}
        const out = await runTool(ev.name, args);
        toolResults.push({ name: ev.name, out });
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(out) } });
        if (out.slide) sendSlideContext();
      })();
      pendingTools.push(p);
      if (ANSWER_AFTER.has(ev.name)) needsFollowup = true;
      break;
    }
    case 'response.done': {
      responding = false;
      if (ev.response?.status === 'cancelled') break;
      const etapa = ev.response?.metadata?.etapa;
      if (etapa === 'falar') {
        if (ev.response?.status === 'incomplete') log('Erro', `fala cortada pela OpenAI: ${JSON.stringify(ev.response.status_details || {})}`);
        if (sleepAfterSpeech) { sleepAfterSpeech = false; engagedUntil = 0; } else if (!guided) engage();
        break;
      }   // acabou de responder: fica acordada para a continuação
      const waiting = pendingTools; pendingTools = [];
      await Promise.all(waiting);
      const results = toolResults; toolResults = [];
      if (needsFollowup) { needsFollowup = false; think(); break; }   // consultou a tela: agora responde
      const guia = results.find(r => r.name === 'explicar_slide' && r.out.ok);
      if (guia) { startGuided(guia.out); break; }
      if (results.length) {
        // agiu: silêncio, a não ser que algo tenha falhado; e volta a dormir até ser chamada
        const fail = results.find(r => !r.out.ok);
        engagedUntil = 0;
        if (results.some(r => r.out.recusa)) refuse();   // o palco recusou confirmar ou aprovar: a fala é a da recusa
        else if (fail) sayAloud(`Não consegui ${fail.name.replace(/_/g, ' ')}: ${fail.out.erro}.`);
        break;
      }
      const text = (ev.response?.output || []).filter(o => o.type === 'message')
        .flatMap(o => o.content || []).map(c => c.text || c.transcript || '').join(' ').trim();
      if (text) sayAloud(text);
      break;
    }
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      if (ev.transcript) log(config.nome, ev.transcript, 'caliope');
      break;
    case 'error':
      log('Erro', ev.error?.message || JSON.stringify(ev.error));
      break;
  }
}

/* ==================== plano B: reconhecimento do Chrome + comandos fixos ==================== */
const COMMANDS = [
  [/(pr[oó]xim|avan[cç]a|seguinte|passa)/i, () => ['proximo_slide', {}, 'Próximo.']],
  [/(volta|anterior|retorna)\b(?!.*slides)/i, () => ['slide_anterior', {}, 'Voltando.']],
  [/slide\s+(\d+|um|dois|tr[eê]s|quatro|cinco)/i, m => {
    const n = { um: 1, dois: 2, tres: 3, 'três': 3, quatro: 4, cinco: 5 }[m[1].toLowerCase()] || Number(m[1]);
    return ['ir_para_slide', { numero: n }, `Slide ${n}.`];
  }],
  [/([uú]ltimo slide|encerramento)/i, () => ['ir_para_slide', { numero: 5 }, 'Indo para o encerramento.']],
  [/(abr[ea]|abrir|cria|criar).*(conta)|demo/i, () => {
    return ['executar_roteiro', { roteiro: 'abrir_conta' }, 'Abrindo a conta no Banco Demo.'];
  }],
  [/(mostra|volta).*(slides|apresenta[cç][aã]o)/i, () => ['mostrar_slides', {}, 'De volta aos slides.']],
];

function speak(text) {
  if (!text || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pt-BR';
  u.voice = speechSynthesis.getVoices().find(v => /^pt[-_]BR$/i.test(v.lang)) || null;   // nunca a voz de Portugal
  u.onstart = () => espectro({ acao: 'sintetico' });
  u.onend = u.onerror = () => espectro({ acao: 'parar' });
  speechSynthesis.speak(u);
}

async function localCommand(text, quietIfUnknown = false) {
  const clean = text.replace(wakeRegex(), ' ');
  for (const [re, make] of COMMANDS) {
    const m = clean.match(re);
    if (!m) continue;
    const [tool, args] = make(m);
    const out = await runTool(tool, args);   // age em silêncio e volta a dormir
    if (!out.ok) speak('Não consegui. ' + (out.erro || ''));
    engagedUntil = 0;
    return true;
  }
  if (!quietIfUnknown) log(config.nome, 'não reconheci esse comando no plano B', 'sistema');
  return false;
}

// ouvido do Chrome: no plano B faz tudo; no modo voz é o "ouvido rápido" que executa comandos diretos e o
// "ok" assim que o Chrome fecha a frase, sem esperar a transcrição da OpenAI (que chega depois e é ignorada)
function startEar() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { if (mode === 'b') throw new Error('este navegador não tem reconhecimento de voz; use o Chrome'); return; }
  recog = new SR();
  recog.lang = 'pt-BR'; recog.continuous = true; recog.interimResults = true;
  recog.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript.trim();
      if (!text) continue;
      // enquanto ela fala, "ok" / "para" calam já no resultado parcial
      if (!e.results[i].isFinal) { if ((speaking || responding) && stopNow(text)) { log('Você', `${text} (rápido: parou)`, 'voce'); hush('parou'); } continue; }
      if ((speaking || guided || performance.now() - caliopeQuietAt < ECHO_TAIL_MS || soundsLikeMe(text)) && !stopNow(text)) continue;   // eco dela
      if (mode === 'voz') {
        if (stopNow(text)) { hush('parou'); engagedUntil = 0; lastFast = { key: 'stop', at: performance.now() }; log('Você', `${text} (rápido)`, 'voce'); }
        if (named(text) && refuseCommand(text)) { lastFast = { key: 'recusa', at: performance.now() }; log('Você', `${text} (rápido)`, 'voce'); refuse(); continue; }
        const direct = directCommand(text);
        if (direct) { lastFast = { key: JSON.stringify(direct), at: performance.now() }; log('Você', `${text} (rápido)`, 'voce'); runDirect(direct); }
        continue;
      }
      if (stopCommand(text)) { hush('parou'); engagedUntil = 0; log('Você', text, 'voce'); continue; }
      if (named(text) && refuseCommand(text)) { log('Você', text, 'voce'); refuse(); continue; }
      const direct = directCommand(text);
      const go = !direct && (named(text) || engaged());
      log('Você', text, direct || go ? 'voce' : 'voce ignored');
      if (direct) runDirect(direct);
      else if (go) localCommand(text, !named(text));
    }
  };
  recog.onend = () => { if (wanted && mode && $('fastEar').checked) try { recog.start(); } catch {} };
  recog.onerror = e => { if (!['no-speech', 'aborted'].includes(e.error)) log('Erro', `reconhecimento: ${e.error}`); };
  recog.start();
}

function startPlanB() {
  startEar();
  setStatus(`plano B · ${config.nome}`, 'wait');
  log('Sistema', 'plano B ligado: comandos fixos pela voz do navegador', 'sistema');
}

/* ==================== botões ==================== */
function setMode(m) {
  mode = m; wanted = !!m;
  $('btnVoice').disabled = $('btnB').disabled = !!m;
  $('btnStop').disabled = !m;
  if (!m) setStatus('desconectado');
}

$('btnStage').onclick = async () => {
  $('btnStage').disabled = true;
  try {
    const out = await post('/api/stage/open');
    if (out.ok === false) throw new Error(out.erro);
    showSlide(out.slide); log('Sistema', 'janela do palco aberta', 'sistema'); sendSlideContext();
  } catch (e) { log('Erro', e.message); }
  $('btnStage').disabled = false;
};

$('btnVoice').onclick = async () => {
  setMode('voz');
  try { await connectVoice(); if ($('fastEar').checked) startEar(); }
  catch (e) { log('Erro', e.message); teardownVoice(); setMode(null); }
};

$('btnB').onclick = async () => {
  setMode('b');
  try { if (!mic) await openMic(); startPlanB(); }
  catch (e) { log('Erro', e.message); setMode(null); }
};

$('btnStop').onclick = () => {
  wanted = false;
  teardownVoice();
  try { recog?.stop(); } catch {}
  setMode(null);
  log('Sistema', 'desconectado', 'sistema');
};

$('btnHush').onclick = () => { hush('silenciada'); engagedUntil = 0; };
addEventListener('keydown', e => { if (e.key === 'Escape') $('btnHush').click(); });

$('espectroTeste').onclick = () => {   // acende as barras por 3 s no palco e aqui, para conferir sem ela falar
  if (!$('espectro').checked) $('espectro').checked = true;
  espectro({ acao: 'sintetico' });
  setTimeout(() => { if (!speaking) espectro({ acao: 'parar' }); }, 3000);
};
$('espectro').onchange = () => { if (!$('espectro').checked) { espectroLigado = true; espectro({ acao: 'parar' }); } };
$('muted').onchange = () => { if (mic) mic.getAudioTracks()[0].enabled = !$('muted').checked; };
$('outSel').onchange = routeOutput;
$('monitor').onchange = routeOutput;
$('micSel').onchange = async () => { if (!mic) return; mic.getTracks().forEach(t => t.stop()); mic = null; await openMic();
  const sender = pc?.getSenders().find(s => s.track?.kind === 'audio'); if (sender) await sender.replaceTrack(mic.getAudioTracks()[0]); };

$('cmd').onsubmit = async e => {
  e.preventDefault();
  const text = $('cmdText').value.trim();
  if (!text) return;
  $('cmdText').value = '';
  log('Você', text, 'voce');
  const direct = directCommand(text);
  if (direct) return runDirect(direct);
  if (refuseCommand(text)) return refuse();   // o sim é do humano, também por escrito
  if (mode === 'voz' && dc?.readyState === 'open') {
    engage();
    send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    think();
  } else {
    await localCommand(text);   // sem voz conectada, o texto usa os comandos do plano B
  }
};

(async () => {
  config = await fetch('/api/config').then(r => r.json()).catch(() => config);
  // aberto pela Mesa da demo: ?demo=<Internet Banking>&sre=<SRE Panel> diz qual demo a Calíope vai operar (local ou OpenShift)
  const q = new URLSearchParams(location.search);
  if (q.has('demo') || q.has('sre')) {
    const alvo = await post('/api/alvo', { demo: q.get('demo') || undefined, sre: q.has('sre') ? q.get('sre') : undefined }).catch(e => ({ ok: false, erro: e.message }));
    if (alvo.ok) log('Sistema', `demo: ${alvo.demo}${alvo.sre ? ' · SRE Panel: ' + alvo.sre : ''}`, 'sistema');
    else log('Erro', `URLs da demo: ${alvo.erro}`);
    history.replaceState(null, '', location.pathname);
  }
  const vs = $('vozSel');
  if (vs) {
    vs.innerHTML = (config.vozes || ['realtime']).map(v => `<option value="${v}">${v === 'realtime' ? 'OpenAI (sotaque americano)' : v + ' · pt-BR'}</option>`).join('');
    vs.value = config.voz || 'realtime';
    vs.onchange = async () => { config.voz = vs.value; vozCache.clear(); await post('/api/voz/escolher', { voz: vs.value }); log('Sistema', `voz: ${vs.value}`, 'sistema'); };
    $('vozTeste').onclick = () => config.voz === 'realtime'
      ? log('Sistema', 'a voz da OpenAI só toca com a voz conectada', 'sistema')
      : sayNative(`Oi, eu sou a ${config.nome}. Vou explicar o Agent Card do Analista de Crédito.`, true);
  }
  if (config.ativacao) $('wake').value = config.ativacao;   // WAKE_WORDS: o nome e as formas como a transcrição costuma escrevê-lo
  if (!$('wake').value.toLowerCase().includes(config.nome.toLowerCase())) $('wake').value = `${config.nome.toLowerCase()}, ${$('wake').value}`;
  if (!config.temChave) { $('btnVoice').disabled = true; $('btnVoice').title = 'defina OPENAI_API_KEY no .env'; }
  log('Sistema', config.temChave ? `pronto · modelo ${config.modelo}` : 'sem OPENAI_API_KEY: use o plano B ou a caixa de texto', 'sistema');
  await listDevices().catch(() => {});
})();
