// server.mjs — serves the copilot, the slides and the demo; creates the voice session and runs the tools.
//   npm start  →  http://localhost:8787
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// simple .env: KEY=value per line, never overriding what already came from the environment
if (existsSync(join(HERE, '.env'))) {
  for (const line of readFileSync(join(HERE, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { INSTRUCTIONS, TOOLS, NAME, VOICE_STYLE, REFUSAL, PHRASES, LANGUAGE, LANG } = await import('./agent.mjs');
const stage = await import('./stage.mjs');

const PORT = Number(process.env.PORT || 8787);
const BASE = `http://localhost:${PORT}`;
const MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-2.1';
const VOICE = process.env.REALTIME_VOICE || 'marin';
const TRANSCRIBE = process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const PUBLIC = join(HERE, 'public');
// Calíope's voice. "realtime": the OpenAI voice (fluent, American accent in other languages).
// Any other value is a macOS voice (say command) for LANGUAGE, e.g. Luciana for pt-BR, Samantha for en-US.
// CALIOPE_VOZ is the old name.
let VOICE_NAME = process.env.CALIOPE_VOICE || process.env.CALIOPE_VOZ || (LANG === 'pt' ? 'Luciana' : '');
const RATE = Number(process.env.CALIOPE_RATE || 195);   // say words per minute
const run = (cmd, args) => new Promise((ok, fail) => execFile(cmd, args, { maxBuffer: 1 << 20 }, (e, out) => e ? fail(e) : ok(out)));
// macOS voices for the talk language (pt_BR for pt-BR; any en_* for en)
async function nativeVoices() {
  if (process.platform !== 'darwin') return [];
  const out = await run('say', ['-v', '?']).catch(() => '');
  const locale = LANGUAGE.includes('-') ? new RegExp(`\\b${LANGUAGE.replace('-', '_')}\\b`) : new RegExp(`\\b${LANG}_`);
  const names = out.split('\n').filter(l => locale.test(l)).map(l => l.split(/\s{2,}|\s\(/)[0].trim())
    .filter(n => n && !/Grandma|Grandpa|Rocko/.test(n));
  return [...new Set(names)];
}
let speechN = 0;
async function synthesize(text, voice) {
  const f = join(tmpdir(), `caliope-voice-${process.pid}-${++speechN}.wav`);
  await run('say', ['-v', voice, '-r', String(RATE), '--file-format=WAVE', '--data-format=LEI16@24000', '-o', f, String(text).slice(0, 4000)]);
  try { return await readFile(f); } finally { unlink(f).catch(() => {}); }
}

stage.configure({ deck: process.env.DECK_URL || `${BASE}/deck/`, demo: process.env.DEMO_URL || `${BASE}/demo/`, sre: process.env.SRE_URL || '' });

// the voice session: responses never start on their own (create_response: false); the copilot asks for one
// only when it hears the assistant's name, which works as the wake word
function sessionConfig() {
  return {
    type: 'realtime', model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, tool_choice: 'auto',
    max_output_tokens: Number(process.env.MAX_OUTPUT_TOKENS || 800),   // safety cap: ~30 s of speech
    audio: {
      input: {
        transcription: { model: TRANSCRIBE, ...(LANGUAGE === 'auto' ? {} : { language: LANG }),
          prompt: `Live technical talk. Names and terms: ${NAME}, slide, demo, OpenShift, Kafka, agent, Red Hat${process.env.SPEECH_TERMS ? ', ' + process.env.SPEECH_TERMS : ''}.` },
        // interrupt_response false: the panel decides whether her speech is cut (noise and her own echo do not cut it)
        turn_detection: { type: 'server_vad', create_response: false, interrupt_response: false,
          threshold: Number(process.env.VAD_THRESHOLD || 0.6), silence_duration_ms: Number(process.env.SILENCE_MS || 300) },
        noise_reduction: { type: 'near_field' },
      },
      output: { voice: VOICE },
    },
  };
}

async function mintSession() {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('OPENAI_API_KEY is not set in .env'), { status: 400 });
  const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 600 }, session: sessionConfig() }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error?.message || `OpenAI answered ${r.status}`), { status: 502 });
  return { key: body.value, model: MODEL };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function serveStatic(req, res) {
  let path = decodeURIComponent(new URL(req.url, BASE).pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { send(res, 404, 'not found'); }
}

function send(res, status, body) {
  const json = typeof body !== 'string';
  res.writeHead(status, { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' });
  res.end(json ? JSON.stringify(body) : body);
}

async function readJson(req, max = Infinity) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > max) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

// ---- demo console scenes on stage ----
// The demo console (Mesa da demo) server sends a scene result from this same machine, with no Origin header. A request
// from another machine on the network, or from a page on another site, is refused: nobody outside writes on the slide.
// Only limited-size text goes in; the deck writes it as text.
// The body fields (id, titulo, onde, estado, linhas) are the console's and the deck's contract: keep them as they are.
const OWN_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const foreign = req => !!req.headers.origin && !OWN_ORIGINS.has(req.headers.origin);
const local = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const SCENE_STATES = ['running', 'canceling', 'ok', 'failed', 'canceled', 'fechar'];
function cleanScene(b) {
  const txt = (v, n) => String(v ?? '').slice(0, n);
  return {
    id: txt(b?.id, 60), titulo: txt(b?.titulo, 90), onde: txt(b?.onde, 90),
    estado: SCENE_STATES.includes(b?.estado) ? b.estado : 'running',
    linhas: (Array.isArray(b?.linhas) ? b.linhas : []).slice(-40).map(l => txt(l, 400)),
  };
}
const time = () => new Date().toLocaleTimeString(LANGUAGE === 'auto' ? undefined : LANGUAGE);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/config') {
      return send(res, 200, { name: NAME, hasKey: !!process.env.OPENAI_API_KEY, model: MODEL, voiceStyle: VOICE_STYLE,
        wakeWords: process.env.WAKE_WORDS || '', voice: VOICE_NAME || 'realtime', voices: ['realtime', ...await nativeVoices()],
        language: LANGUAGE, lang: LANG, phrases: PHRASES, refusal: REFUSAL });
    }
    if (req.method === 'POST' && req.url === '/api/log') {   // what the panel shows also goes to the server log, with time
      const { who, text } = await readJson(req);
      console.log(`${time()} · ${who}: ${text}`);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/api/target') return send(res, 200, stage.targets());
    if (req.method === 'POST' && req.url === '/api/target') {
      // the demo console opens the panel with ?demo=…&sre=…; the panel forwards them here
      const { demo, sre } = await readJson(req);
      const ok = v => v === undefined || v === '' || /^https?:\/\//.test(v);
      if (!ok(demo) || !ok(sre)) return send(res, 400, { ok: false, error: 'invalid URL' });
      const u = await stage.retarget({ ...(demo ? { demo } : {}), ...(sre !== undefined ? { sre } : {}) });
      console.log(`target: demo ${u.demo} · SRE ${u.sre || '(none)'}`);
      return send(res, 200, { ok: true, ...u });
    }
    if (req.method === 'POST' && req.url === '/api/voice/select') {
      const { voice } = await readJson(req);
      if (voice) VOICE_NAME = String(voice);
      return send(res, 200, { ok: true, voice: VOICE_NAME });
    }
    if (req.method === 'POST' && req.url === '/api/voice') {
      const { text, voice } = await readJson(req);
      const audio = await synthesize(text, voice || VOICE_NAME);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
      return res.end(audio);
    }
    if (req.method === 'POST' && req.url === '/api/session') return send(res, 200, await mintSession());
    if (req.method === 'POST' && req.url === '/api/stage/open') return send(res, 200, await stage.open());
    if (req.method === 'POST' && req.url === '/api/stage/badge') {
      const { state, name } = await readJson(req);
      return send(res, 200, await stage.setBadge(state, name));
    }
    if (req.method === 'POST' && req.url === '/api/stage/spectrum') return send(res, 200, await stage.spectrum(await readJson(req)));
    if (req.method === 'POST' && req.url === '/api/stage/close') return send(res, 200, await stage.close());
    if (req.method === 'POST' && req.url === '/api/stage/cena') {
      if (!local(req) || foreign(req)) return send(res, 403, { ok: false, error: 'origin not allowed' });
      return send(res, 200, await stage.scene(cleanScene(await readJson(req, 64 * 1024))));
    }
    if (req.method === 'POST' && req.url === '/api/tool') {
      const { name, args } = await readJson(req);
      const started = Date.now();
      try {
        const out = await stage.run(name, args || {});
        if (out?.refused) out.say = REFUSAL;   // the yes is human: the panel reads this sentence instead of "I couldn't"
        console.log(`${time()} ${out?.refused ? '∅ refused' : '✓'} ${name} ${JSON.stringify(args || {})} ${Date.now() - started}ms`);
        return send(res, 200, out);
      } catch (e) {
        console.log(`✗ ${name}: ${e.message}`);
        return send(res, 200, { ok: false, error: e.message.split('\n')[0] });
      }
    }
    if (req.method === 'GET') return serveStatic(req, res);
    send(res, 405, 'method not allowed');
  } catch (e) {
    send(res, e.status || 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Copilot: ${BASE}  (slides ${BASE}/deck/ · demo ${BASE}/demo/ · language ${LANGUAGE})`);
  if (!process.env.OPENAI_API_KEY) console.log('No OPENAI_API_KEY: only browser mode (plan B) will work.');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await stage.close(); process.exit(0); });
