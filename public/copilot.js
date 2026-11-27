/* copilot.js — listens to the presenter, talks to the voice API and calls the stage tools.
   Two modes:
   - OpenAI voice (Realtime over WebRTC): understands free requests, speaks with a natural voice, picks the tools;
   - plan B (Chrome speech recognition + fixed commands): free, for when the API or the network fails.
   Text typed in the command box follows the active mode's path.
   Voice commands are recognized in Portuguese and English; she speaks the talk's language (LANGUAGE). */
'use strict';

const $ = id => document.getElementById(id);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok && j.error) throw new Error(j.error); return j; });

let config = { name: 'Calíope', language: 'pt-BR', lang: 'pt', phrases: {} };
const phrase = (k, vars = {}) => Object.entries({ name: config.name, ...vars })
  .reduce((s, [a, b]) => s.replaceAll(`{${a}}`, b), config.phrases?.[k] || '');
let mode = null;            // 'voice' | 'b' | null
let wanted = false;         // the presenter wants voice on: reconnects by itself if the session drops
let pc, dc, mic, meterStop;
let pendingTools = [], needsFollowup = false;
let currentSlide = null;
let recog;

/* ==================== on-screen log ==================== */
function log(who, text, cls = '') {
  const el = document.createElement('div');
  el.className = cls || who.toLowerCase();
  el.innerHTML = `<span class="who"></span><span class="txt"></span>`;
  el.querySelector('.who').textContent = who;
  el.querySelector('.txt').textContent = text;
  $('log').appendChild(el);
  if (/system|error|action|assistant/.test(el.className)) fetch('/api/log', { method: 'POST', body: JSON.stringify({ who, text: String(text).slice(0, 200) }) }).catch(() => {});
  $('log').scrollTop = $('log').scrollHeight;
  return el;
}
// time since you stopped talking: shown in the log to find where the latency is
let tStop = 0;
const since = () => tStop ? ` · ${Math.round(performance.now() - tStop)} ms` : '';

function setStatus(text, cls = '') { $('status').textContent = text; $('status').className = 'pill ' + cls; }
function showSlide(s) {
  if (!s) return;
  currentSlide = s;
  $('slideTitle').textContent = s.number ? `${s.number}/${s.total} · ${s.title}` : s.title;
  $('slideInfo').textContent = s.notes || '';
}

/* ==================== when Calíope pays attention ====================
   Three ways to talk to her, fastest to freest:
   1. direct command ("next slide", "back", "slide 3", "próximo slide"): runs at once, no name, no model;
   2. by name ("Calíope, ..."): opens a conversation window;
   3. inside the window (30 s by default after the last exchange), anything goes to the model, which decides
      whether it is for her or for the audience (wait tool = silence). "Always listening" keeps the window open. */
// With or without accents: "Calíope", "Caliope" and "CALÍOPE" wake her the same, from the field or the transcript.
const ACCENTS = { a: 'aáàâã', e: 'eéêè', i: 'iíîì', o: 'oóôõò', u: 'uúûùü', c: 'cç' };
const wakePattern = w => [...w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()]
  .map(ch => ACCENTS[ch] ? `[${ACCENTS[ch]}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
function wakeRegex() {
  const words = $('wake').value.split(',').map(w => w.trim()).filter(Boolean);
  if (!words.length) words.push(config.name);
  return new RegExp(`(^|[^\\p{L}])(${words.map(wakePattern).join('|')})(?=$|[^\\p{L}])`, 'iu');
}
const named = text => wakeRegex().test(text);
// "Calíope, próximo slide." → "proximo slide": no name, accents, punctuation or case
const plain = text => text.replace(wakeRegex(), ' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^\p{L}\d\s']/gu, ' ').replace(/'/g, '').replace(/\s+/g, ' ').trim();

let engagedUntil = 0;
const engaged = () => $('openMode').checked || Date.now() < engagedUntil;
function engage() { engagedUntil = Date.now() + Number($('windowSec').value || 30) * 1000; }
// awake = hears everything; asleep = only her name or a direct command. Shown in the panel and,
// if checked, in a discreet badge on the stage window (the server is told only when the state changes)
let lastBadge = '';
setInterval(() => {
  const left = Math.ceil((engagedUntil - Date.now()) / 1000);
  const state = !mode ? 'off' : $('openMode').checked || left > 0 ? 'awake' : 'asleep';
  const mood = $('mood');
  mood.className = 'mood ' + state;
  mood.querySelector('b').textContent = state === 'off' ? 'Off' : state === 'awake' ? 'Listening' : 'Asleep';
  mood.querySelector('span').textContent = state === 'off' ? 'connect the voice to start'
    : $('openMode').checked ? 'always listening, talk normally'
    : state === 'awake' ? `talk normally · sleeps in ${left}s`
    : `say "${config.name}" or a direct command`;
  if (mode === 'voice') setStatus(dc?.readyState === 'open' ? 'voice connected' : 'connecting…', dc?.readyState === 'open' ? 'on' : 'wait');
  else if (mode === 'b') setStatus('plan B', 'wait');
  const badge = $('stageBadge').checked ? state : 'off';
  if (badge !== lastBadge) { lastBadge = badge; post('/api/stage/badge', { state: badge, name: config.name }).catch(() => {}); }
}, 400);

const NUM = { um: 1, dois: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const N = Object.keys(NUM).join('|');
// a direct command is only the command: "In the next slide we will see..." does not change slides
const DIRECT = [
  // Portuguese
  [/^(?:(?:ok|entao|bora|agora)\s+)?(?:proxim[oa](?: slide)?|avanca(?: o slide)?|passa(?: o slide)?|slide seguinte|seguinte)$/, () => ['next_slide', {}]],
  [/^(?:(?:ok|entao)\s+)?(?:volta(?: um)?(?: o)?(?: slide)?|slide anterior|anterior)$/, () => ['previous_slide', {}]],
  [new RegExp(`^(?:(?:vai|volta) (?:para|pro|pra) (?:o )?)?slide (\\d+|${N})$`), m => ['go_to_slide', { number: NUM[m[1]] || Number(m[1]) }]],
  [/^(?:mostra|volta (?:para|pros|pra)) (?:os )?slides$/, () => ['show_slides', {}]],
  [/^(?:mostra|volta (?:para|pra|pro)|vai (?:para|pra|pro)|vamos (?:para|pra|pro)) (?:a )?apresentacao$/, () => ['show_tab', { tab: 'presentation' }]],
  [/^(?:vai|vamos|volta) (?:para|pra|pro) (?:a |o )?(?:demo|banco|agentic bank)$/, () => ['show_tab', { tab: 'bank' }]],
  [/^(?:vai|vamos) (?:para|pra|pro) (?:o )?(?:sre panel|painel (?:do )?sre|sre)$/, () => ['show_tab', { tab: 'sre' }]],
  // English
  [/^(?:(?:ok|okay|so|now)\s+)?(?:next(?: slide)?(?: please)?|advance|go forward|forward)$/, () => ['next_slide', {}]],
  [/^(?:(?:ok|okay|so)\s+)?(?:previous(?: slide)?|go back(?: one)?(?: slide)?|back(?: one)?(?: slide)?|last slide back)$/, () => ['previous_slide', {}]],
  [new RegExp(`^(?:(?:go|jump|back) to )?(?:the )?slide (?:number )?(\\d+|${N})$`), m => ['go_to_slide', { number: NUM[m[1]] || Number(m[1]) }]],
  [/^(?:show(?: me)?|back to|go back to) (?:the )?slides$/, () => ['show_slides', {}]],
  [/^(?:show|back to|go back to|go to|lets go to) (?:the )?presentation$/, () => ['show_tab', { tab: 'presentation' }]],
  [/^(?:go|lets go|back|go back) to (?:the )?(?:demo|bank|agentic bank)$/, () => ['show_tab', { tab: 'bank' }]],
  [/^(?:go|lets go) to (?:the )?(?:sre panel|sre)$/, () => ['show_tab', { tab: 'sre' }]],
];
function directCommand(text) {
  const t = plain(text);
  for (const [re, make] of DIRECT) { const m = t.match(re); if (m) return make(m); }
  return null;
}

// "ok", "para", "stop", "thanks, Calíope", "pode dormir": she goes quiet at once and back to sleep
const STOP = new RegExp('^(?:(?:ok|ta|tudo bem|okay|all right|alright)\\s+)?(?:'
  + 'ok|okay|ok ok|ta bom|ta|certo|entendi|perfeito|para|pare|chega|silencio|quieta|pode parar|para de falar|obrigad[oa]|valeu|beleza|'
  + 'dorme|pode dormir|vai dormir|ja deu|espera|so um minuto|'
  + 'stop|stop it|stop talking|please stop|thanks|thank you|thank you very much|enough|thats enough|quiet|be quiet|silence|'
  + 'got it|perfect|all right|alright|go to sleep|sleep|wait|hold on|one moment|one minute'
  + ')$');
// With the native voice, the fast ear hears Calíope herself: a lone word like "para" or "stop" in the middle of her
// speech must not silence her. While she speaks, stopping by voice needs her name ("Calíope, stop"); Esc always works.
const nativeVoice = () => config.voice && config.voice !== 'realtime';
const whileTalking = () => speaking || !!guided || performance.now() - caliopeQuietAt < ECHO_TAIL_MS;
const stopNow = text => stopCommand(text) && (!nativeVoice() || !whileTalking() || named(text));
const stopCommand = text => STOP.test(plain(text));

// "Calíope, confirm it for me?": the yes belongs to the human. A request to confirm, approve or authorize, said with
// her name, gets the ready refusal at once, without the model. Without the name, the sentence takes the normal path:
// the model has the same rule (agent.mjs) and the stage refuses the tool (stage.mjs). "Confirm whether the balance is
// right" is a question, not a request for a yes, and also takes the normal path.
const REFUSE_PT = '^(?:(?:entao|agora|por favor|ok|ai|e ai|vai)\\s+)*'
  + '(?:(?:voce\\s+)?(?:pode|consegue|quer|poderia|da (?:para|pra)|tem como)\\s+)?(?:voce\\s+)?(?:'
  + '(?:confirm|aprov|autoriz)(?:a|e|ar)\\b(?!\\s+(?:(?:para|pra)\\s+(?:mim|a gente|nos)\\s+)?(?:se|que|qual|quais|quanto|quanta|quando|onde|como|quem)\\b)'
  + '|(?:clica|clicar|clique|aperta|apertar|aperte)\\s+(?:em\\s+|no\\s+botao\\s+(?:de\\s+)?|o\\s+botao\\s+(?:de\\s+)?|no\\s+|o\\s+)?(?:confirmar|aprovar|autorizar|sim)\\b'
  + '|(?:responde|responda|responder|diz|diga|dizer|fala|fale|falar|digita|digite|digitar|escreve|escreva|escrever|manda|mande|mandar)\\s+(?:que\\s+|um\\s+|o\\s+)?sim\\b'
  + '|da\\s+o\\s+(?:seu\\s+)?sim\\b)';
const REFUSE_EN = '^(?:(?:so|now|please|ok|okay|go on|come on)\\s+)*'
  + '(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?(?:please\\s+)?(?:'
  + '(?:confirm|approve|authorize|authorise)\\b(?!\\s+(?:(?:it|this|that)\\s+)?(?:for\\s+(?:me|us)\\s+)?(?:if|whether|that|what|which|how|when|where|who)\\b)'
  + '|(?:click|press|hit|tap)\\s+(?:on\\s+)?(?:the\\s+)?(?:confirm|approve|authorize|yes)\\b'
  + '|(?:say|answer|reply|respond|type|write|send)\\s+(?:with\\s+)?(?:a\\s+)?yes\\b'
  + '|give\\s+(?:it\\s+|them\\s+)?(?:the\\s+|your\\s+)?yes\\b)';
const REFUSE = new RegExp(`(?:${REFUSE_PT})|(?:${REFUSE_EN})`);
const refuseCommand = text => REFUSE.test(plain(text));
// The refusal is one utterance, the same on every path, and after it she sleeps: the presenter's next sentence is for
// the audience. The same request can arrive through the fast ear, the transcript and a refused tool: she says it once.
let lastRefusal = -1e9;
function refuse() {
  const now = performance.now();
  if (now - lastRefusal < 8000) return;
  lastRefusal = now;
  engagedUntil = 0;
  const line = config.refusal || phrase('refusal');
  if (nativeVoice() || dc?.readyState === 'open') sayAloud(line, { sleep: true });
  else { log(config.name, line, 'assistant'); speak(line); }   // plan B: the browser voice
}
// the model learns that the request was already answered: it does not act on it later, nor repeat the sentence
function noteRefusal() {
  send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text',
    text: `The presenter asked you to confirm or approve an operation, and you already answered aloud: "${config.refusal || ''}" `
      + 'Topic closed: confirm nothing, do not repeat the sentence and do not comment.' }] } });
}

// the same command can arrive twice: first through Chrome's fast ear, then through the OpenAI transcript
let lastFast = { key: '', at: 0 };
function already(key) {
  if (lastFast.key === key && performance.now() - lastFast.at < 5000) { lastFast = { key: '', at: 0 }; return true; }
  return false;
}

async function runDirect([tool, args]) {
  const out = await runTool(tool, args);
  sendSlideContext();   // the model learns about the new slide without saying anything
  return out;
}

/* ==================== tools (same in both modes) ==================== */
async function runTool(name, args) {
  const line = log('Action', `${name} ${Object.keys(args).length ? JSON.stringify(args) : ''}…`, 'action');
  try {
    const out = await post('/api/tool', { name, args });
    line.querySelector('.txt').textContent = `${name} ${out.ok ? '✓' : out.refused ? '∅ refused: the yes is human' : '✗ ' + out.error}${since()}`;
    if (!out.ok && !out.refused) line.className = 'error';
    if (out.slide) showSlide(out.slide);
    return out;
  } catch (e) {
    line.className = 'error';
    line.querySelector('.txt').textContent = `${name} ✗ ${e.message}`;
    return { ok: false, error: e.message };
  }
}

/* ==================== audio: devices, output and meter ==================== */
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
  // the voice goes to the chosen output (BlackHole → Meet) and, if asked, also to the default device (your headphones)
  const out = $('audioOut'), mon = $('audioMon');
  try { if (out.setSinkId) await out.setSinkId($('outSel').value || ''); } catch (e) { log('Error', `audio output: ${e.message}`); }
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
  await listDevices();   // device names show up after the permission
}

/* ==================== voice mode: OpenAI Realtime over WebRTC ==================== */
const send = ev => { if (dc?.readyState === 'open') dc.send(JSON.stringify(ev)); };

function sendSlideContext() {
  if (!currentSlide) return;
  send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text',
    text: `Current slide ${currentSlide.number || ''}/${currentSlide.total || ''}: "${currentSlide.title}". Notes: ${currentSlide.notes || '(no notes)'}` }] } });
}

async function connectVoice() {
  setStatus('connecting…', 'wait');
  const { key, model } = await post('/api/session');
  pc = new RTCPeerConnection();
  pc.ontrack = e => { $('audioOut').srcObject = e.streams[0]; $('audioMon').srcObject = e.streams[0]; routeOutput(); };
  if (!mic) await openMic();
  pc.addTrack(mic.getAudioTracks()[0], mic);
  dc = pc.createDataChannel('oai-events');
  dc.onopen = () => { setStatus(`listening · ${config.name}`, 'on'); log('System', `voice connected (${model})`, 'system'); sendSlideContext(); };
  dc.onmessage = e => onEvent(JSON.parse(e.data));
  dc.onclose = () => dropped('event channel closed');
  pc.onconnectionstatechange = () => { if (pc && ['failed', 'closed'].includes(pc.connectionState)) dropped(`connection ${pc.connectionState}`); };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const r = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
    method: 'POST', body: offer.sdp, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/sdp' },
  });
  if (!r.ok) throw new Error(`OpenAI refused the connection (${r.status}): ${(await r.text()).slice(0, 200)}`);
  await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
}

let reconnecting = false;
async function dropped(why) {
  if (!wanted || mode !== 'voice' || reconnecting) return;
  reconnecting = true;
  log('System', `${why}; reconnecting…`, 'system');
  teardownVoice();
  for (let i = 0; wanted && i < 5; i++) {
    try { await connectVoice(); break; }
    catch (e) { log('Error', e.message); await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  reconnecting = false;
}

function teardownVoice() {
  try { dc?.close(); } catch {}
  try { pc?.close(); } catch {}
  dc = pc = undefined;
}

/* ---------- think silently, speak only for answers ----------
   Every request first becomes a text-only response (no sound). If the model called tools, they run silently
   and Calíope goes back to sleep: she only speaks again when you call her. If the model answered with text
   (a question, an explanation), a second step reads that text aloud. So she never narrates actions. */
let responding = false, speaking = false, interrupted = false;
const BARGE_MS = 500;   // how much continuous sound cuts her speech
let bargeTimer = 0;
const duringCaliope = new Set();   // utterances that started while she was speaking
// Her voice leaves the speaker and comes back through the mic. Three defenses so she never answers herself:
// 1) speech that starts while she speaks (or up to ECHO_TAIL_MS after) is echo; 2) a transcript close to something
// she just said is echo, but only while she speaks or up to ECHO_TEXT_MS after (the transcript arrives late);
// 3) after a guided explanation she sleeps.
// Rule (Nov 15): with her quiet, your speech is never echo. Before, rule 2 lasted 90 s and "thinking" (responding,
// no sound out) also marked echo: after a long explanation, almost everything the presenter said on the same topic
// was dropped.
const ECHO_TAIL_MS = 1500, ECHO_TEXT_MS = 4000;
let caliopeQuietAt = -1e9;
const spoken = [];   // { words:Set, at }
const wordsOf = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
function remember(text) { spoken.push({ words: new Set(wordsOf(text)), at: performance.now() }); if (spoken.length > 30) spoken.shift(); }
function soundsLikeMe(text) {
  const w = wordsOf(text);
  if (w.length < 2) return false;
  const now = performance.now();
  if (!speaking && !guided && now - caliopeQuietAt > ECHO_TEXT_MS) return false;   // quiet: never echo
  return spoken.some(s => now - s.at < 90000 && w.filter(x => s.words.has(x)).length / w.length >= 0.6);
}
const ANSWER_AFTER = new Set(['read_screen']);   // lookup tools: after them she answers the question
let toolResults = [];

const think = () => send({ type: 'response.create', response: { output_modalities: ['text'], metadata: { stage: 'decide' } } });
// Guided explanation: each part ends only at the REAL end of the audio (output_audio_buffer.stopped, from the native
// audio "ended" or the end of the OpenAI audio); only then does the step advance and the next part start. No other
// speech goes over it while she explains: only "stop" or Esc (hush) stop the whole sequence.
let sleepAfterSpeech = false;   // sleep: after this utterance she does not stay awake waiting for a follow-up
function sayAloud(text, { guide = false, sleep = false } = {}) {
  if (guided && !guide) { log(config.name, `(explaining: not talking over it) ${text}`, 'system'); return; }
  remember(text);
  if (!config.voice || config.voice === 'realtime') {
    sleepAfterSpeech = sleep;
    send({ type: 'response.create', response: {
      conversation: 'none', output_modalities: ['audio'], metadata: { stage: 'speak' },
      // the session cap (800 tokens, ~30 s) used to cut long guided-explanation parts in the middle
      max_output_tokens: 'inf',
      instructions: `${config.voiceStyle || ''}\nRead the text below aloud exactly, adding and removing nothing:\n${text}`,
    } });
    return;
  }
  sayNative(text, sleep);
}

/* spectrum: animated bars over the stage and this panel only while she speaks, tied to the "speaking" state (synthetic
   animation). The panel neither plays nor decodes the audio for it: the voice goes out exactly as before. See public/spectrum.js. */
let spectrumOn = false;
function spectrum(msg) {   // isolated: nothing here may affect speaking or listening
  try {
    if (msg.action !== 'stop' && !$('spectrum')?.checked) return;
    if (msg.action === 'stop' && !spectrumOn) return;
    spectrumOn = msg.action !== 'stop';
    window.__caliSpectrum?.cmd(msg);   // here in the panel too (only 5 CSS bars; no audio)
    post('/api/stage/spectrum', { name: config.name, ...msg }).catch(() => {});
  } catch {}
}
/* native macOS voice: the server generates the audio and it goes out through the same devices as the OpenAI voice.
   The same states (speaking, guided explanation, "stop") apply. */
let nativeAudio = [];
// With the native voice the browser does not cancel echo. While she speaks (and during the whole guided explanation),
// the mic that goes to OpenAI is closed: the model never hears her voice. "Stop" still works through Chrome's fast
// ear and Esc.
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
  nativeAudio.forEach(a => { a.onended = null; a.pause(); });   // never two utterances at once
  deaf(true);
  const myTurn = ++nativeTurn;
  let blob;
  try {
    blob = await voiceBlob(text);
  } catch (e) {
    log('Error', `voice: ${e.message}`);
    // in a guided explanation a part without audio is never skipped: the whole explanation stops and she sleeps
    if (guided) { guided = null; deaf(false); engagedUntil = 0; caliopeQuietAt = performance.now(); log(config.name, '(explanation stopped: the voice failed on this part)', 'system'); }
    return;
  }
  if (myTurn !== nativeTurn) return;   // cut while the audio was being generated
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
    if (!guided && !quiet) engage();   // just answered: stays awake for the follow-up
  };
  log(config.name, text, 'assistant');
  onEvent({ type: 'output_audio_buffer.started' });
  nativeAudio.forEach(a => a.play().catch(e => log('Error', `voice: ${e.message}`)));
}
let nativeTurn = 0;
// audio requested ahead of time (guided explanation): each part is ready when the previous one ends
const voiceCache = new Map();
function voiceBlob(text) {
  if (!voiceCache.has(text)) {
    voiceCache.set(text, fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: config.voice }) })
      .then(r => { if (!r.ok) throw new Error(`voice answered ${r.status}`); return r.blob(); })
      .catch(e => { voiceCache.delete(text); throw e; }));
    if (voiceCache.size > 40) voiceCache.delete(voiceCache.keys().next().value);
  }
  return voiceCache.get(text);
}
function stopNative() {
  nativeTurn++;
  setTimeout(() => deaf(false), 0);
  nativeAudio.forEach(a => { a.pause(); a.src = ''; });
  nativeAudio = [];
}

/* ---------- guided explanation (explain_slide) ----------
   The deck has a prepared line for each step of the slide. She lights up the step, reads the line, waits for the
   audio to end (real end-of-audio event) and moves on. Only "stop" or Esc interrupt; then she sleeps. */
let guided = null;
function startGuided(out) {
  guided = { parts: out.parts || [], i: -1 };
  log(config.name, `(explaining the slide in ${guided.parts.length} parts)`, 'system');
  if (nativeVoice()) [out.intro, ...guided.parts].filter(Boolean).forEach(t => voiceBlob(t).catch(() => {}));
  if (out.intro) { guided.speaking = -1; sayAloud(out.intro, { guide: true }); } else guidedNext();
}
// No timers (Nov 15 rule): the next step only comes from the real end of the previous part's audio. A step without a
// line lights up together with the next one, at the same moment, and the next one's line starts right after.
async function guidedNext() {
  while (guided) {
    const g = guided;
    g.i++;
    if (g.i >= g.parts.length) { guided = null; deaf(false); engagedUntil = 0; caliopeQuietAt = performance.now(); log(config.name, '(explanation done, sleeping)', 'system'); return; }
    await runTool('next_slide', {});
    if (guided !== g) return;
    const line = g.parts[g.i];
    if (line) { g.speaking = g.i; sayAloud(line, { guide: true }); return; }
  }
}

function hush(why) {
  guided = null;
  stopNative();
  if ('speechSynthesis' in window) speechSynthesis.cancel();   // plan B
  if (responding) send({ type: 'response.cancel' });
  if (speaking || responding) send({ type: 'output_audio_buffer.clear' });   // cuts the audio already going out
  needsFollowup = false; pendingTools = []; toolResults = [];
  if (responding || speaking) log(config.name, `(${why})`, 'system');
  responding = speaking = false;
  spectrum({ action: 'stop' });
}

async function onEvent(ev) {
  switch (ev.type) {
    case 'response.created': responding = true; break;
    case 'output_audio_buffer.started': speaking = true; spectrum({ action: 'synthetic' }); log('System', `started speaking${since()}`, 'system'); break;
    case 'input_audio_buffer.speech_stopped': tStop = performance.now(); clearTimeout(bargeTimer); break;
    case 'output_audio_buffer.stopped':
      speaking = false; caliopeQuietAt = performance.now(); spectrum({ action: 'stop' });
      // a guided-explanation part finished its audio: the next one starts now (one advance per part, never two)
      if (guided && guided.speaking === guided.i) { guided.speaking = null; guidedNext(); }
      break;
    case 'output_audio_buffer.cleared': speaking = false; spectrum({ action: 'stop' }); break;
    case 'input_audio_buffer.speech_started':
      // sound on the mic while she speaks: could be you, her own voice coming back from the room, or noise.
      // That utterance is marked: its transcript only counts if it is "stop", "ok", "para"...
      if (speaking || guided || performance.now() - caliopeQuietAt < ECHO_TAIL_MS) duringCaliope.add(ev.item_id);   // thinking (responding) makes no sound: not echo
      // in a guided explanation she does not stop for any sound: only for a stop word or Esc
      if (guided) break;
      // otherwise she stops only if the sound lasts BARGE_MS (cough, door and short echo do not cut)
      if ((speaking || responding) && $('bargeIn').checked) {
        clearTimeout(bargeTimer);
        bargeTimer = setTimeout(() => { if (speaking || responding) { interrupted = true; hush('interrupted'); } }, BARGE_MS);
      }
      break;
    case 'conversation.item.input_audio_transcription.completed': {
      const text = (ev.transcript || '').trim();
      if (!text) return;
      const echo = duringCaliope.delete(ev.item_id) || soundsLikeMe(text);
      if (echo && !stopNow(text)) {
        if (ev.item_id) send({ type: 'conversation.item.delete', item_id: ev.item_id });
        log('You', `${text} (echo of her speech: ignored)`, 'you ignored'); break; }
      if (stopNow(text)) {
        hush('stopped'); engagedUntil = 0; interrupted = false;
        if (already('stop')) break;
        log('You', text + since(), 'you');
        log(config.name, '(sleeping)', 'system');
        break;
      }
      if (named(text) && refuseCommand(text)) {   // "confirm it for me?": the ready refusal, without the model
        interrupted = false;
        if (!already('refusal')) { log('You', text + since(), 'you'); refuse(); }
        noteRefusal();
        break;
      }
      const direct = directCommand(text);
      // the utterance that interrupted her only becomes a request if it has her name
      const go = !direct && (named(text) || (engaged() && !interrupted));
      interrupted = false;
      if (direct && already(JSON.stringify(direct))) break;   // Chrome already ran it
      log('You', text + since(), direct || go ? 'you' : 'you ignored');
      if (direct) { runDirect(direct); break; }
      if (named(text)) engage();
      if (go) think();
      break;
    }
    case 'response.function_call_arguments.done': {
      if (ev.name === 'wait') {   // not for her: stays quiet, no follow-up response
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: '{"ok":true}' } });
        log(config.name, '(not for me, waiting)', 'system');
        break;
      }
      if (ev.name === 'explain_slide' && guided) {   // already explaining: does not restart
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: '{"ok":true,"note":"already explaining"}' } });
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
      const stage = ev.response?.metadata?.stage;
      if (stage === 'speak') {
        if (ev.response?.status === 'incomplete') log('Error', `speech cut by OpenAI: ${JSON.stringify(ev.response.status_details || {})}`);
        if (sleepAfterSpeech) { sleepAfterSpeech = false; engagedUntil = 0; } else if (!guided) engage();
        break;
      }   // just answered: stays awake for the follow-up
      const waiting = pendingTools; pendingTools = [];
      await Promise.all(waiting);
      const results = toolResults; toolResults = [];
      if (needsFollowup) { needsFollowup = false; think(); break; }   // looked at the screen: now answers
      const guide = results.find(r => r.name === 'explain_slide' && r.out.ok);
      if (guide) { startGuided(guide.out); break; }
      if (results.length) {
        // acted: silence, unless something failed; and back to sleep until called
        const fail = results.find(r => !r.out.ok);
        engagedUntil = 0;
        if (results.some(r => r.out.refused)) refuse();   // the stage refused to confirm or approve: the line is the refusal
        else if (fail) sayAloud(phrase('failed', { error: fail.out.error }));
        break;
      }
      const text = (ev.response?.output || []).filter(o => o.type === 'message')
        .flatMap(o => o.content || []).map(c => c.text || c.transcript || '').join(' ').trim();
      if (text) sayAloud(text);
      break;
    }
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      if (ev.transcript) log(config.name, ev.transcript, 'assistant');
      break;
    case 'error':
      log('Error', ev.error?.message || JSON.stringify(ev.error));
      break;
  }
}

/* ==================== plan B: Chrome recognition + fixed commands (pt and en) ==================== */
const COMMANDS = [
  [/(pr[oó]xim|avan[cç]a|seguinte|passa|\bnext\b|advance)/i, () => ['next_slide', {}]],
  [/(volta|anterior|retorna|\bback\b|previous)\b(?!.*slides)/i, () => ['previous_slide', {}]],
  [new RegExp(`slide\\s+(\\d+|${N}|tr[eê]s)`, 'i'), m => ['go_to_slide', { number: NUM[m[1].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')] || Number(m[1]) }]],
  [/([uú]ltimo slide|encerramento|last slide|closing)/i, () => ['go_to_slide', { number: 5 }]],
  [/((abr[ea]|abrir|cria|criar).*(conta)|open.*account|\bdemo\b)/i, () => ['run_script', { script: 'open_account' }]],
  [/((mostra|volta).*(slides|apresenta[cç][aã]o)|(show|back to).*(slides|presentation))/i, () => ['show_slides', {}]],
];

function speak(text) {
  if (!text || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  if (config.language !== 'auto') u.lang = config.language;
  // exact locale first (pt-BR, never the Portugal voice), then the same language
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find(v => v.lang.replace('_', '-').toLowerCase() === String(config.language).toLowerCase())
    || (config.lang === 'pt' ? null : voices.find(v => v.lang.toLowerCase().startsWith(config.lang))) || null;
  u.onstart = () => spectrum({ action: 'synthetic' });
  u.onend = u.onerror = () => spectrum({ action: 'stop' });
  speechSynthesis.speak(u);
}

async function localCommand(text, quietIfUnknown = false) {
  const clean = text.replace(wakeRegex(), ' ');
  for (const [re, make] of COMMANDS) {
    const m = clean.match(re);
    if (!m) continue;
    const [tool, args] = make(m);
    const out = await runTool(tool, args);   // acts silently and goes back to sleep
    if (!out.ok) speak(phrase('failed', { error: out.error || '' }));
    engagedUntil = 0;
    return true;
  }
  if (!quietIfUnknown) log(config.name, 'plan B did not recognize that command', 'system');
  return false;
}

// Chrome's ear: in plan B it does everything; in voice mode it is the "fast ear" that runs direct commands and
// "ok"/"stop" as soon as Chrome closes the sentence, without waiting for the OpenAI transcript (which comes later and is ignored)
function startEar() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { if (mode === 'b') throw new Error('this browser has no speech recognition; use Chrome'); return; }
  recog = new SR();
  recog.lang = config.language === 'auto' ? navigator.language : config.language; recog.continuous = true; recog.interimResults = true;
  recog.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript.trim();
      if (!text) continue;
      // while she speaks, "ok" / "stop" silence her already on the partial result
      if (!e.results[i].isFinal) { if ((speaking || responding) && stopNow(text)) { log('You', `${text} (fast: stopped)`, 'you'); hush('stopped'); } continue; }
      if ((speaking || guided || performance.now() - caliopeQuietAt < ECHO_TAIL_MS || soundsLikeMe(text)) && !stopNow(text)) continue;   // her echo
      if (mode === 'voice') {
        if (stopNow(text)) { hush('stopped'); engagedUntil = 0; lastFast = { key: 'stop', at: performance.now() }; log('You', `${text} (fast)`, 'you'); }
        if (named(text) && refuseCommand(text)) { lastFast = { key: 'refusal', at: performance.now() }; log('You', `${text} (fast)`, 'you'); refuse(); continue; }
        const direct = directCommand(text);
        if (direct) { lastFast = { key: JSON.stringify(direct), at: performance.now() }; log('You', `${text} (fast)`, 'you'); runDirect(direct); }
        continue;
      }
      if (stopCommand(text)) { hush('stopped'); engagedUntil = 0; log('You', text, 'you'); continue; }
      if (named(text) && refuseCommand(text)) { log('You', text, 'you'); refuse(); continue; }
      const direct = directCommand(text);
      const go = !direct && (named(text) || engaged());
      log('You', text, direct || go ? 'you' : 'you ignored');
      if (direct) runDirect(direct);
      else if (go) localCommand(text, !named(text));
    }
  };
  recog.onend = () => { if (wanted && mode && $('fastEar').checked) try { recog.start(); } catch {} };
  recog.onerror = e => { if (!['no-speech', 'aborted'].includes(e.error)) log('Error', `recognition: ${e.error}`); };
  recog.start();
}

function startPlanB() {
  startEar();
  setStatus(`plan B · ${config.name}`, 'wait');
  log('System', 'plan B on: fixed commands through the browser voice', 'system');
}

/* ==================== buttons ==================== */
function setMode(m) {
  mode = m; wanted = !!m;
  $('btnVoice').disabled = $('btnB').disabled = !!m;
  $('btnStop').disabled = !m;
  if (!m) setStatus('disconnected');
}

$('btnStage').onclick = async () => {
  $('btnStage').disabled = true;
  try {
    const out = await post('/api/stage/open');
    if (out.ok === false) throw new Error(out.error);
    showSlide(out.slide); log('System', 'stage window open', 'system'); sendSlideContext();
  } catch (e) { log('Error', e.message); }
  $('btnStage').disabled = false;
};

$('btnVoice').onclick = async () => {
  setMode('voice');
  try { await connectVoice(); if ($('fastEar').checked) startEar(); }
  catch (e) { log('Error', e.message); teardownVoice(); setMode(null); }
};

$('btnB').onclick = async () => {
  setMode('b');
  try { if (!mic) await openMic(); startPlanB(); }
  catch (e) { log('Error', e.message); setMode(null); }
};

$('btnStop').onclick = () => {
  wanted = false;
  teardownVoice();
  try { recog?.stop(); } catch {}
  setMode(null);
  log('System', 'disconnected', 'system');
};

$('btnHush').onclick = () => { hush('silenced'); engagedUntil = 0; };
addEventListener('keydown', e => { if (e.key === 'Escape') $('btnHush').click(); });

$('spectrumTest').onclick = () => {   // lights the bars for 3 s on stage and here, to check without her speaking
  if (!$('spectrum').checked) $('spectrum').checked = true;
  spectrum({ action: 'synthetic' });
  setTimeout(() => { if (!speaking) spectrum({ action: 'stop' }); }, 3000);
};
$('spectrum').onchange = () => { if (!$('spectrum').checked) { spectrumOn = true; spectrum({ action: 'stop' }); } };
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
  log('You', text, 'you');
  const direct = directCommand(text);
  if (direct) return runDirect(direct);
  if (refuseCommand(text)) return refuse();   // the yes is human, in writing too
  if (mode === 'voice' && dc?.readyState === 'open') {
    engage();
    send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    think();
  } else {
    await localCommand(text);   // without voice connected, text uses the plan B commands
  }
};

(async () => {
  config = await fetch('/api/config').then(r => r.json()).catch(() => config);
  // opened by the demo console: ?demo=<Internet Banking>&sre=<SRE Panel> says which demo Calíope runs (local or OpenShift)
  const q = new URLSearchParams(location.search);
  if (q.has('demo') || q.has('sre')) {
    const target = await post('/api/target', { demo: q.get('demo') || undefined, sre: q.has('sre') ? q.get('sre') : undefined }).catch(e => ({ ok: false, error: e.message }));
    if (target.ok) log('System', `demo: ${target.demo}${target.sre ? ' · SRE Panel: ' + target.sre : ''}`, 'system');
    else log('Error', `demo URLs: ${target.error}`);
    history.replaceState(null, '', location.pathname);
  }
  const vs = $('voiceSel');
  if (vs) {
    vs.innerHTML = (config.voices || ['realtime']).map(v => `<option value="${v}">${v === 'realtime' ? 'OpenAI' : `${v} · ${config.language}`}</option>`).join('');
    vs.value = config.voice || 'realtime';
    vs.onchange = async () => { config.voice = vs.value; voiceCache.clear(); await post('/api/voice/select', { voice: vs.value }); log('System', `voice: ${vs.value}`, 'system'); };
    $('voiceTest').onclick = () => config.voice === 'realtime'
      ? log('System', 'the OpenAI voice only plays with the voice connected', 'system')
      : sayNative(phrase('hello'), true);
  }
  if (config.wakeWords) $('wake').value = config.wakeWords;   // WAKE_WORDS: the name and the ways the transcript tends to spell it
  if (!$('wake').value.toLowerCase().includes(config.name.toLowerCase())) $('wake').value = `${config.name.toLowerCase()}, ${$('wake').value}`;
  if (!config.hasKey) { $('btnVoice').disabled = true; $('btnVoice').title = 'set OPENAI_API_KEY in .env'; }
  log('System', config.hasKey ? `ready · model ${config.model} · ${config.language}` : 'no OPENAI_API_KEY: use plan B or the text box', 'system');
  await listDevices().catch(() => {});
})();
