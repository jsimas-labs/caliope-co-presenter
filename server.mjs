// server.mjs — serve o co-piloto, os slides e a demo; cria a sessão de voz e executa as ferramentas.
//   npm start  →  http://localhost:8787
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// .env simples: CHAVE=valor por linha, sem sobrescrever o que já veio do ambiente
if (existsSync(join(HERE, '.env'))) {
  for (const line of readFileSync(join(HERE, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { INSTRUCTIONS, TOOLS, NAME, VOICE_STYLE, RECUSA } = await import('./agent.mjs');
const stage = await import('./stage.mjs');

const PORT = Number(process.env.PORT || 8787);
const BASE = `http://localhost:${PORT}`;
const MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-2.1';
const VOICE = process.env.REALTIME_VOICE || 'marin';
const TRANSCRIBE = process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const PUBLIC = join(HERE, 'public');
// Voz da Calíope. "realtime": a voz da OpenAI (fluente, mas com sotaque americano).
// Qualquer outro valor é uma voz pt-BR do macOS (comando say): Luciana, Flo, Reed, Sandy, Shelley, Eddy.
let CALIOPE_VOZ = process.env.CALIOPE_VOZ || 'Luciana';
const CALIOPE_RATE = Number(process.env.CALIOPE_RATE || 195);   // palavras por minuto do say
const run = (cmd, args) => new Promise((ok, fail) => execFile(cmd, args, { maxBuffer: 1 << 20 }, (e, out) => e ? fail(e) : ok(out)));
async function vozesBR() {
  if (process.platform !== 'darwin') return [];
  const out = await run('say', ['-v', '?']).catch(() => '');
  const nomes = out.split('\n').filter(l => /pt_BR/.test(l)).map(l => l.split(/\s{2,}|\s\(/)[0].trim())
    .filter(n => n && !/Grandma|Grandpa|Rocko/.test(n));
  return [...new Set(nomes)];
}
let falaN = 0;
async function sintetizar(texto, voz) {
  const f = join(tmpdir(), `caliope-voz-${process.pid}-${++falaN}.wav`);
  await run('say', ['-v', voz, '-r', String(CALIOPE_RATE), '--file-format=WAVE', '--data-format=LEI16@24000', '-o', f, String(texto).slice(0, 4000)]);
  try { return await readFile(f); } finally { unlink(f).catch(() => {}); }
}

stage.configure({ deck: process.env.DECK_URL || `${BASE}/deck/`, demo: process.env.DEMO_URL || `${BASE}/demo/`, sre: process.env.SRE_URL || '' });

// a sessão de voz: a resposta não sai sozinha (create_response: false); o co-piloto só pede
// resposta quando ouve o nome da assistente, e isso funciona como palavra de ativação
function sessionConfig() {
  return {
    type: 'realtime', model: MODEL, instructions: INSTRUCTIONS, tools: TOOLS, tool_choice: 'auto',
    max_output_tokens: Number(process.env.MAX_OUTPUT_TOKENS || 800),   // teto de segurança: ~30 s de fala
    audio: {
      input: {
        transcription: { model: TRANSCRIBE, language: 'pt',
          prompt: `Português do Brasil. Palestra técnica ao vivo. Nomes e termos: ${NAME}, slide, demo, Banco Demo, OpenShift, Kafka, agente, Red Hat${process.env.SPEECH_TERMS ? ', ' + process.env.SPEECH_TERMS : ''}.` },
        // interrupt_response falso: quem decide se a fala dela é cortada é o painel (barulho e eco da própria voz não cortam)
        turn_detection: { type: 'server_vad', create_response: false, interrupt_response: false,
          threshold: Number(process.env.VAD_THRESHOLD || 0.6), silence_duration_ms: Number(process.env.SILENCE_MS || 300) },
        noise_reduction: { type: 'near_field' },
      },
      output: { voice: VOICE },
    },
  };
}

async function mintSession() {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('OPENAI_API_KEY não definida no .env'), { status: 400 });
  const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 600 }, session: sessionConfig() }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error?.message || `OpenAI respondeu ${r.status}`), { status: 502 });
  return { key: body.value, model: MODEL };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function serveStatic(req, res) {
  let path = decodeURIComponent(new URL(req.url, BASE).pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'proibido');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { send(res, 404, 'não encontrado'); }
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
    if (raw.length > max) throw Object.assign(new Error('corpo grande demais'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

// ---- cenas da Mesa da demo no palco ----
// Quem manda o resultado de uma cena é o servidor da Mesa, nesta mesma máquina e sem cabeçalho Origin. Um pedido que
// vem de outra máquina da rede, ou de uma página de outro site, é recusado: ninguém de fora escreve no slide.
// O que entra é só texto, com tamanho limitado; o deck o escreve como texto.
const OWN_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const foreign = req => !!req.headers.origin && !OWN_ORIGINS.has(req.headers.origin);
const local = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const CENA_ESTADOS = ['running', 'canceling', 'ok', 'failed', 'canceled', 'fechar'];
function cenaLimpa(b) {
  const txt = (v, n) => String(v ?? '').slice(0, n);
  return {
    id: txt(b?.id, 60), titulo: txt(b?.titulo, 90), onde: txt(b?.onde, 90),
    estado: CENA_ESTADOS.includes(b?.estado) ? b.estado : 'running',
    linhas: (Array.isArray(b?.linhas) ? b.linhas : []).slice(-40).map(l => txt(l, 400)),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/config') {
      return send(res, 200, { nome: NAME, temChave: !!process.env.OPENAI_API_KEY, modelo: MODEL, estiloVoz: VOICE_STYLE, ativacao: process.env.WAKE_WORDS || '', voz: CALIOPE_VOZ, vozes: ['realtime', ...await vozesBR()], recusa: RECUSA });
    }
    if (req.method === 'POST' && req.url === '/api/log') {   // o que o painel mostra também fica no log do servidor, com hora
      const { quem, texto } = await readJson(req);
      console.log(`${new Date().toLocaleTimeString('pt-BR')} · ${quem}: ${texto}`);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/api/alvo') return send(res, 200, stage.alvos());
    if (req.method === 'POST' && req.url === '/api/alvo') {
      // a Mesa da demo abre o painel com ?demo=…&sre=…; o painel repassa aqui
      const { demo, sre } = await readJson(req);
      const ok = v => v === undefined || v === '' || /^https?:\/\//.test(v);
      if (!ok(demo) || !ok(sre)) return send(res, 400, { ok: false, erro: 'URL inválida' });
      const u = await stage.retarget({ ...(demo ? { demo } : {}), ...(sre !== undefined ? { sre } : {}) });
      console.log(`alvo: demo ${u.demo} · SRE ${u.sre || '(nenhum)'}`);
      return send(res, 200, { ok: true, ...u });
    }
    if (req.method === 'POST' && req.url === '/api/voz/escolher') {
      const { voz } = await readJson(req);
      if (voz) CALIOPE_VOZ = String(voz);
      return send(res, 200, { ok: true, voz: CALIOPE_VOZ });
    }
    if (req.method === 'POST' && req.url === '/api/voz') {
      const { texto, voz } = await readJson(req);
      const audio = await sintetizar(texto, voz || CALIOPE_VOZ);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
      return res.end(audio);
    }
    if (req.method === 'POST' && req.url === '/api/session') return send(res, 200, await mintSession());
    if (req.method === 'POST' && req.url === '/api/stage/open') return send(res, 200, await stage.open());
    if (req.method === 'POST' && req.url === '/api/stage/badge') {
      const { estado, nome } = await readJson(req);
      return send(res, 200, await stage.setBadge(estado, nome));
    }
    if (req.method === 'POST' && req.url === '/api/stage/espectro') return send(res, 200, await stage.espectro(await readJson(req)));
    if (req.method === 'POST' && req.url === '/api/stage/close') return send(res, 200, await stage.close());
    if (req.method === 'POST' && req.url === '/api/stage/cena') {
      if (!local(req) || foreign(req)) return send(res, 403, { ok: false, erro: 'origem não permitida' });
      return send(res, 200, await stage.cena(cenaLimpa(await readJson(req, 64 * 1024))));
    }
    if (req.method === 'POST' && req.url === '/api/tool') {
      const { name, args } = await readJson(req);
      const started = Date.now();
      try {
        const out = await stage.run(name, args || {});
        if (out?.recusa) out.fala = RECUSA;   // o sim é do humano: o painel lê esta frase no lugar de "não consegui"
        console.log(`${new Date().toLocaleTimeString('pt-BR')} ${out?.recusa ? '∅ recusou' : '✓'} ${name} ${JSON.stringify(args || {})} ${Date.now() - started}ms`);
        return send(res, 200, out);
      } catch (e) {
        console.log(`✗ ${name}: ${e.message}`);
        return send(res, 200, { ok: false, erro: e.message.split('\n')[0] });
      }
    }
    if (req.method === 'GET') return serveStatic(req, res);
    send(res, 405, 'método não suportado');
  } catch (e) {
    send(res, e.status || 500, { ok: false, erro: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Co-piloto: ${BASE}  (slides ${BASE}/deck/ · demo ${BASE}/demo/)`);
  if (!process.env.OPENAI_API_KEY) console.log('Sem OPENAI_API_KEY: só o modo navegador (plano B) vai funcionar.');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await stage.close(); process.exit(0); });
