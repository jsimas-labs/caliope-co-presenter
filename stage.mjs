// stage.mjs — a "janela do palco": um navegador controlado pelo Playwright com duas abas,
// os slides e a página da demo. É essa janela que você compartilha no Meet.
// A assistente age aqui como um usuário: o cursor anda até o alvo, clica e digita letra por letra.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const HEADLESS = process.env.HEADLESS === '1';
const CHANNEL = process.env.BROWSER_CHANNEL || undefined;   // 'chrome' usa o Google Chrome instalado
// digitação no ritmo de uma pessoa média: ~40 palavras por minuto (200 caracteres/min, 300 ms por tecla)
const TYPE_WPM = Number(process.env.TYPE_WPM || 40);
const CURSOR_STEPS = Number(process.env.CURSOR_STEPS || 16);   // menos passos = cursor mais rápido

let browser, context, deck, demo, obs, sre;
let urls = { deck: '', demo: '' };
export const configure = u => { urls = u; };
export const alvos = () => ({ ...urls });
// troca as URLs da demo com o palco aberto (botões da Mesa: local ou OpenShift). As abas abertas seguem as novas URLs.
export async function retarget(u) {
  const old = urls;
  urls = { ...urls, ...Object.fromEntries(Object.entries(u).filter(([, v]) => typeof v === 'string')) };
  if (demo && !demo.isClosed() && urls.demo && urls.demo !== old.demo) await demo.goto(urls.demo).catch(() => {});
  if (sre && !sre.isClosed() && urls.sre !== old.sre) {
    if (urls.sre) await sre.goto(urls.sre).catch(() => {}); else { await sre.close().catch(() => {}); sre = undefined; }
  }
  if (obs && !obs.isClosed() && urls.demo !== old.demo) { await obs.close().catch(() => {}); obs = undefined; }
  if (deck && !deck.isClosed()) { await pushAlvos(); await deck.bringToFront().catch(() => {}); }
  return alvos();
}

// cursor visível: os eventos de mouse do Playwright são reais, então a bolinha segue o movimento
const GHOST_CURSOR = `(() => {
  const add = () => {
    if (document.getElementById('__ghost')) return;
    const c = document.createElement('div');
    c.id = '__ghost';
    c.style.cssText = 'position:fixed;left:-40px;top:-40px;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;'
      + 'background:rgba(238,0,0,.28);border:2px solid #e00;box-shadow:0 0 12px rgba(238,0,0,.5);z-index:2147483647;'
      + 'pointer-events:none;transition:transform .1s;';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(.6)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = ''; }, true);
    // dentro de um iframe (demo embutida no deck) quem desenha o cursor é a página de dentro
    addEventListener('mouseover', e => { if (e.target.tagName === 'IFRAME') { c.style.left = '-40px'; c.style.top = '-40px'; } }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', add); else add();
})();`;

async function ensureContext() {
  if (context && browser?.isConnected()) return context;
  browser = await chromium.launch({ headless: HEADLESS, channel: CHANNEL, args: ['--start-maximized'] });
  context = await browser.newContext({ viewport: HEADLESS ? { width: 1280, height: 800 } : null, locale: 'pt-BR' });
  await context.addInitScript(GHOST_CURSOR);
  deck = demo = obs = sre = undefined;
  return context;
}

async function deckPage() {
  await ensureContext();
  if (!deck || deck.isClosed()) {
    deck = await context.newPage();
    deck.on('load', () => paintBadge(deck));
    await deck.goto(urls.deck);
    await pushAlvos();
  }
  await deck.bringToFront();
  return deck;
}

// ---- demo embutida no deck ----
// Um deck com window.deck.vivo traz o banco, o SRE Panel e o Observatório em janelas (iframes) dentro dos slides.
// Aí não há abas: os roteiros agem dentro do iframe, e o mouse e o teclado continuam sendo os da página do deck.
async function embedded() {
  if (!deck || deck.isClosed()) await deckPage();
  return deck.evaluate(() => !!window.deck?.vivo).catch(() => false);
}
// o deck aprende onde estão o banco e o SRE Panel (DEMO_URL/SRE_URL ou a Mesa); ele mesmo não mistura local e cluster
async function pushAlvos() {
  if (!deck || deck.isClosed() || !urls.demo) return;
  await deck.evaluate(u => window.deck?.alvos?.(u), { demo: urls.demo, sre: urls.sre }).catch(() => {});
}
// as teclas voltam para os slides depois que um roteiro digitou dentro de um iframe
async function releaseKeys() {
  if (deck && !deck.isClosed()) await deck.evaluate(() => window.deck?.sair?.()).catch(() => {});
}
function asPage(page, frame, home) {
  return new Proxy(frame, {
    get(t, k) {
      if (k === 'home') return home;
      if (k === 'mouse' || k === 'keyboard') return page[k];
      if (k === 'bringToFront') return async () => {};
      if (k === 'isClosed') return () => t.isDetached();
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}
// app: banco, sre ou observatorio. mostrar=false deixa o slide atual na tela (o empréstimo corre por trás).
async function liveFrame(app, mostrar = true) {
  const p = await deckPage();
  const info = await p.evaluate(([a, m]) => window.deck.vivo(a, m), [app, mostrar]);
  if (!info || !info.url) throw new Error(`${app}: sem endereço no ambiente ${info?.ambiente || ''} (seletor Local/OpenShift na barra da janela)`);
  const h = await p.locator(`.livewin[data-app="${app}"] iframe`).elementHandle();
  const f = await h.contentFrame();
  if (!f) throw new Error(`${app}: a janela ainda não carregou`);
  await f.waitForLoadState('domcontentloaded').catch(() => {});
  return asPage(p, f, info.url);
}

async function demoPage(url, front = true) {
  if (await embedded()) {
    const p = await liveFrame('banco', front);
    if (url) await p.goto(url);
    return p;
  }
  await ensureContext();
  if (!demo || demo.isClosed()) {
    demo = await context.newPage();
    demo.on('load', () => paintBadge(demo));
  }
  if (url || demo.url() === 'about:blank') await demo.goto(url || urls.demo);
  if (front) await demo.bringToFront();
  return demo;
}

// SRE Panel: terceira aba fixa do palco (SRE_URL). Só vem para a frente quando pedido.
async function srePage(front = true) {
  if (await embedded()) return liveFrame('sre', front);
  if (!urls.sre) throw new Error('SRE Panel não configurado (SRE_URL)');
  await ensureContext();
  if (!sre || sre.isClosed()) {
    sre = await context.newPage();
    sre.on('load', () => paintBadge(sre));
    await sre.goto(urls.sre);
  }
  if (front) await sre.bringToFront();
  return sre;
}

// Observatório numa aba própria: a conversa do banco continua viva na aba do banco
async function obsPage() {
  if (await embedded()) return liveFrame('observatorio');
  await ensureContext();
  if (!obs || obs.isClosed()) {
    obs = await context.newPage();
    obs.on('load', () => paintBadge(obs));
    await obs.goto(new URL('/observatory', urls.demo).href);
  }
  await obs.bringToFront();
  return obs;
}

// o slide atual: o deck de teste expõe window.deck.state(); qualquer outro deck cai no título visível
async function slideState(p) {
  return p.evaluate(() => {
    if (window.deck?.state) return window.deck.state();
    const h = document.querySelector('.slide.active h1, .slide.active h2, h1, h2');
    return { titulo: h ? h.textContent.trim().replace(/\s+/g, ' ') : document.title };
  });
}

async function key(k, times = 1) {
  const p = await deckPage();
  await releaseKeys();
  for (let i = 0; i < times; i++) { await p.keyboard.press(k); await p.waitForTimeout(60); }
  await p.waitForLoadState('domcontentloaded');   // decks de uma página por slide (como o bbdw) navegam a cada tecla
  return { ok: true, slide: await slideState(p) };
}

// acha o elemento pelo que uma pessoa diria: rótulo, nome do botão ou link, placeholder, texto
async function find(p, alvo) {
  const candidates = [
    p.getByLabel(alvo), p.getByRole('button', { name: alvo }), p.getByRole('link', { name: alvo }),
    p.getByPlaceholder(alvo), p.getByText(alvo),
  ];
  for (const c of candidates) {
    const el = c.first();
    if (await el.count() && await el.isVisible().catch(() => false)) return el;
  }
  throw new Error(`não encontrei "${alvo}" na tela`);
}

async function moveTo(p, el) {
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  if (!b) throw new Error('o elemento não está visível');
  const x = b.x + Math.min(b.width / 2, 40), y = b.y + b.height / 2;
  await p.mouse.move(x, y, { steps: CURSOR_STEPS });
  await p.waitForTimeout(70);
  return { x, y };
}

async function clickEl(p, el) {
  const { x, y } = await moveTo(p, el);
  await p.mouse.click(x, y);
  await p.waitForTimeout(120);
}

// uma tecla por vez, com o ritmo irregular de gente: varia ±45% e hesita depois de espaço e pontuação
async function typeHuman(p, text) {
  const base = 60000 / (TYPE_WPM * 5);
  for (const ch of String(text)) {
    await p.keyboard.type(ch);
    let wait = base * (0.55 + Math.random() * 0.9);
    if (ch === ' ') wait += base * 0.6;
    if (/[.,@]/.test(ch)) wait += base * 0.8;
    await p.waitForTimeout(wait);
  }
}

async function fillEl(p, el, valor) {
  await clickEl(p, el);
  await el.fill('');
  await typeHuman(p, valor);
}

async function selectEl(p, el, opcao) {
  await moveTo(p, el);
  const options = await el.locator('option').allTextContents();
  const want = opcao.toLowerCase();
  const label = options.find(o => o.toLowerCase() === want) || options.find(o => o.toLowerCase().includes(want));
  if (!label) throw new Error(`a lista não tem "${opcao}". Opções: ${options.join(', ')}`);
  await el.selectOption({ label });
  await p.waitForTimeout(250);
  return label;
}

async function readScreen(p) {
  return p.evaluate(() => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const labelOf = el => (el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.placeholder || el.name || '').trim();
    const campos = [...document.querySelectorAll('input, select, textarea')].filter(vis)
      .map(el => ({ campo: labelOf(el), tipo: el.type || el.tagName.toLowerCase(), valor: el.type === 'checkbox' ? el.checked : el.value }));
    const botoes = [...document.querySelectorAll('button, a[href], [role=button]')].filter(vis)
      .map(el => el.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 30);
    const texto = document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 1800);
    return { titulo: document.title, url: location.href, campos, botoes, texto, selo: document.getElementById('__caliope_badge')?.textContent || null };
  });
}

const SAMPLE = { email: 'maria.oliveira@exemplo.com', renda: '8500', produto: 'Conta digital + cartão' };

async function scriptOpenAccount(nome = 'Maria Oliveira') {
  const p = await demoPage(urls.demo);
  await p.waitForTimeout(600);
  await fillEl(p, await find(p, 'Nome completo'), nome);
  const email = nome === 'Maria Oliveira' ? SAMPLE.email
    : nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, '.') + '@exemplo.com';
  await fillEl(p, await find(p, 'E-mail'), email);
  await fillEl(p, await find(p, 'Renda mensal'), SAMPLE.renda);
  await selectEl(p, await find(p, 'Produto'), SAMPLE.produto);
  await clickEl(p, await find(p, 'Li e aceito os termos'));
  await clickEl(p, await find(p, 'Abrir conta'));
  const done = p.getByTestId('resultado');
  await done.waitFor({ state: 'visible', timeout: 8000 });
  return { ok: true, resultado: (await done.innerText()).replace(/\s+/g, ' ').trim() };
}

// Agentic Bank: abre o banco como o cliente pedido, com o chat aberto. Não recarrega a página, para manter a conversa.
async function bankReady(cliente, { reload = false, front = true } = {}) {
  const p = await demoPage(undefined, front);
  if (reload || !await p.locator('#customerPicker').count()) await p.goto(p.home || urls.demo);
  await p.waitForSelector('#customerPicker');
  await p.waitForFunction(() => document.getElementById('customerPicker').options.length > 0);
  if (cliente) {
    const picker = p.locator('#customerPicker');
    const atual = await picker.evaluate(e => e.selectedOptions[0]?.text || '');
    // trocar de cliente recarrega a página (?customer=...)
    if (!atual.toLowerCase().includes(cliente.toLowerCase())) {
      await Promise.all([p.waitForNavigation({ waitUntil: 'load' }), selectEl(p, picker, cliente)]);
      await p.waitForSelector('#customerPicker');
      await p.waitForFunction(() => document.getElementById('customerPicker').options.length > 0);
    }
  }
  // o chat já existe na página mesmo com o painel fechado: quem diz se está aberto é a classe
  if (!await p.locator('#floatPanel.panel-open').count()) {
    // por trás de outro slide (demo embutida) um clique de mouse cairia na janela da frente: clique pelo DOM
    if (front) await clickEl(p, p.locator('#floatToggle')); else await p.locator('#floatToggle').dispatchEvent('click');
    await p.waitForTimeout(450);
  }
  await p.locator('#q').waitFor({ state: 'visible', timeout: 5000 });
  return p;
}

// toda pergunta nova começa uma conversa nova: o Observatório mostra só os saltos desta pergunta
async function newChat(p, human = true) {
  const nova = p.locator('#newChat');
  if (!await nova.isVisible().catch(() => false)) return;
  if (human) await clickEl(p, nova); else await nova.dispatchEvent('click');
  await p.waitForTimeout(300);
}

async function scriptAskBank(cliente, pergunta) {
  const p = await bankReady(cliente);
  await newChat(p);
  await fillEl(p, p.locator('#q'), pergunta);
  await clickEl(p, p.getByRole('button', { name: 'Enviar' }));
  await releaseKeys();
  return { ok: true, enviado: pergunta, cliente: cliente || 'cliente atual' };
}

// "Calíope, inicia a demo" e "Calíope, reinicia a demo": banco recarregado, conversa nova, e a pergunta do saldo
async function scriptStartBank(cliente = 'Ana', pergunta = 'Qual o meu saldo?') {
  const p = await bankReady(cliente, { reload: true });
  await newChat(p);
  await fillEl(p, p.locator('#q'), pergunta);
  await clickEl(p, p.getByRole('button', { name: 'Enviar' }));
  await releaseKeys();
  return { ok: true, enviado: pergunta, cliente, conversa: 'nova' };
}

// "Calíope, continua": pede o empréstimo pelo chat, na aba do banco, sem tirar o Observatório da tela.
// Quando vier a oferta, pede para contratar; para quando o banco pedir a confirmação do cliente (o clique humano).
const BOT = '#log .bubble.bot:not(.muted)';
async function sendInBackground(p, text) {
  const before = await p.locator(BOT).count();
  await p.locator('#q').fill(text);
  await p.locator('#q').press('Enter');
  await releaseKeys();
  return before;
}
async function waitReply(p, before, timeout = 240000) {
  await p.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length > n, [BOT, before], { timeout, polling: 1000 });
  return (await p.locator(BOT).last().innerText()).replace(/\s+/g, ' ').trim();
}
export let loanStatus = { fase: 'parado' };
async function loanFlow(p, before, valor) {
  const asksConfirm = t => /confirm|autoriz|\bsim\b|posso (prosseguir|contratar|seguir)|deseja (contratar|prosseguir)/i.test(t) && /\?/.test(t);
  try {
    loanStatus = { fase: 'pedido enviado, esperando a oferta', valor };
    let reply = await waitReply(p, before);
    loanStatus = { fase: 'oferta recebida', resposta: reply };
    console.log(`  empréstimo · resposta 1: ${reply.slice(0, 160)}`);
    if (!asksConfirm(reply) && /oferta|parcela|aprovad|liberad|taxa/i.test(reply)) {
      const b2 = await sendInBackground(p, 'Quero contratar essa oferta.');
      loanStatus = { fase: 'pediu para contratar, esperando a confirmação' };
      reply = await waitReply(p, b2);
      console.log(`  empréstimo · resposta 2: ${reply.slice(0, 160)}`);
    }
    loanStatus = asksConfirm(reply)
      ? { fase: 'esperando a confirmação humana (INPUT_REQUIRED)', resposta: reply }
      : { fase: 'parou sem pedido de confirmação: veja o chat', resposta: reply };
  } catch (e) {
    loanStatus = { fase: 'falhou', erro: e.message.split('\n')[0] };
  }
  console.log(`  empréstimo · ${loanStatus.fase}`);
}
async function scriptLoan(valor = 20000, prazo = 24) {
  const p = await bankReady(null, { front: false });
  const brl = Number(valor).toLocaleString('pt-BR');
  const pedido = `Quero pedir um empréstimo de R$ ${brl} em ${prazo} meses.`;
  await newChat(p, false);   // conversa nova para o pedido; o "quero contratar" segue nela
  const before = await sendInBackground(p, pedido);
  loanFlow(p, before, valor);   // segue sozinho; a resposta da ferramenta não espera o modelo
  return { ok: true, enviado: pedido, segue: 'no chat do banco, em segundo plano, até o pedido de confirmação do cliente' };
}

// selo discreto no canto da janela do palco: a plateia vê que a Calíope está ouvindo, e você sabe se precisa chamá-la
let badge = { estado: 'off', nome: 'Calíope' };
async function paintBadge(p) {
  if (!p || p.isClosed()) return;
  await p.evaluate(({ estado, nome }) => {
    let b = document.getElementById('__caliope_badge');
    if (estado === 'off') { b?.remove(); return; }
    if (!b) {
      b = document.createElement('div');
      b.id = '__caliope_badge';
      b.style.cssText = 'position:fixed;right:18px;top:14px;z-index:2147483646;display:flex;align-items:center;gap:8px;'
        + 'padding:7px 13px 7px 10px;border-radius:99px;font:600 13px/1 Inter,system-ui,sans-serif;pointer-events:none;'
        + 'backdrop-filter:blur(6px);transition:all .3s;';
      b.innerHTML = '<i style="width:10px;height:10px;border-radius:50%;display:block"></i><span></span>';
      document.documentElement.appendChild(b);
    }
    const on = estado === 'acordada';
    b.style.background = on ? 'rgba(22,163,74,.88)' : 'rgba(40,40,46,.78)';
    b.style.color = '#fff';
    b.querySelector('i').style.background = on ? '#bbf7d0' : '#9ca3af';
    b.querySelector('span').textContent = on ? `${nome} ouvindo` : `${nome} dormindo · diga "${nome}"`;
  }, badge).catch(() => {});
}
export async function setBadge(estado, nome) {
  badge = { estado, nome: nome || badge.nome };
  await Promise.all([deck, demo, obs, sre].map(paintBadge));
  return { ok: true };
}

// espectro de áudio da co-apresentadora por cima das abas do palco, só enquanto ela fala (public/espectro.js).
// O painel avisa quando ela começa e para de falar; cada aba anima sozinha.
// O arquivo é relido a cada chamada: mudar o visual vale na próxima fala, sem reiniciar o servidor.
// Uma versão nova substitui a antiga já injetada na aba (destroy).
export async function espectro(msg) {
  const src = readFileSync(new URL('./public/espectro.js', import.meta.url), 'utf8');
  let h = 0; for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0;
  const all = [deck, demo, obs, sre].filter(p => p && !p.isClosed());
  const js = `if (window.__caliEspectro?.v !== ${h}) { try { window.__caliEspectro?.destroy?.(); } catch {} `
    + `document.getElementById('__cali_espectro')?.remove(); window.__caliEspectro = undefined;\n${src}\n;window.__caliEspectro.v = ${h}; }\n`
    + `window.__caliEspectro.cmd(${JSON.stringify(msg)})`;
  await Promise.all(all.map(p => p.evaluate(js).catch(() => {})));
  return { ok: true, abas: all.length };
}

// A Mesa da demo espelha aqui o resultado de uma cena do cluster (o 403 do Seguros, o orçamento do Crédito): o deck
// mostra num cartão por cima do slide atual (window.deck.cena). Com o palco fechado, ou num deck que não conhece
// cenas, nada acontece: o resultado continua no console da Mesa.
export async function cena(c) {
  if (!deck || deck.isClosed()) return { ok: true, mostrado: false, motivo: 'palco fechado' };
  const mostrado = await deck.evaluate(x => (window.deck?.cena ? (window.deck.cena(x), true) : false), c).catch(() => false);
  return mostrado ? { ok: true, mostrado } : { ok: true, mostrado, motivo: 'este deck não mostra cenas' };
}

// abrir o palco monta as abas na ordem da apresentação: Apresentação, Agentic Bank, SRE Panel.
// Elas ficam abertas; pedir a demo ou os slides só troca a aba da frente, sem recarregar nada.
export async function open() {
  const p = await deckPage();
  if (await embedded()) return { ok: true, slide: await slideState(p) };   // banco e SRE Panel moram nos slides
  if (!demo || demo.isClosed()) {
    demo = await context.newPage();
    demo.on('load', () => paintBadge(demo));
    await demo.goto(urls.demo).catch(e => console.log(`  aba do banco: ${e.message.split('\n')[0]}`));
  }
  if (urls.sre && (!sre || sre.isClosed())) await srePage(false).catch(e => console.log(`  aba do SRE Panel: ${e.message.split('\n')[0]}`));
  await p.bringToFront();
  return { ok: true, slide: await slideState(p) };
}

async function showTab(aba) {
  const a = String(aba || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (await embedded()) {
    if (/apresent|slide/.test(a)) {
      const p = await deckPage();
      await p.evaluate(() => window.deck.voltar());
      return { ok: true, slide: await slideState(p) };
    }
    const app = /sre|painel|panel/.test(a) ? 'sre' : /observ/.test(a) ? 'observatorio' : /banco|demo|bank/.test(a) ? 'banco' : '';
    if (!app) throw new Error(`não conheço a aba "${aba}"`);
    const f = await liveFrame(app);
    return { ok: true, slide: await slideState(deck), url: f.url() };
  }
  if (/apresent|slide/.test(a)) return open();
  if (/sre|painel|panel/.test(a)) {
    const p = await srePage();
    // só traz a aba para a frente: quem acorda o sre-agent é o seu primeiro clique na página
    return { ok: true, aba: 'SRE Panel', url: p.url() };
  }
  if (/observ/.test(a)) { const p = await obsPage(); return { ok: true, aba: 'Observatório', url: p.url() }; }
  if (/banco|demo|bank/.test(a)) { const p = await demoPage(); return { ok: true, aba: 'Agentic Bank', url: p.url() }; }
  throw new Error(`não conheço a aba "${aba}"`);
}

export async function close() {
  await browser?.close().catch(() => {});
  browser = context = deck = demo = obs = sre = undefined;
  return { ok: true };
}

// ---- o "sim" é do humano ----
// A co-apresentadora nunca confirma, aprova nem autoriza nada na demo, nem a pedido. As ferramentas livres recusam
// o clique num botão de confirmar ou aprovar, e recusam digitar o que o banco conta como o "sim" do cliente
// (a mesma lista do banco: AFFIRMATIVE em OpenAiCompatResource.java). O roteiro do empréstimo não passa por aqui:
// ele pede a oferta e para sozinho no pedido de confirmação.
// HUMAN_ONLY_CLICK e HUMAN_ONLY_TEXT no ambiente trocam as listas (expressão regular sobre o texto sem acento).
const plain = t => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^\p{L}\d\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const HUMAN_CLICK = new RegExp(process.env.HUMAN_ONLY_CLICK
  || String.raw`\b(confirm\w*|aprov\w*|autoriz\w*|aceit\w*|contrat\w*|efetiv\w*|sim|yes)\b`);
const HUMAN_TEXT = new RegExp(process.env.HUMAN_ONLY_TEXT
  || String.raw`\b(sim|confirmo|confirma|confirmar|confirmado|confirmada|pode executar|pode prosseguir|pode contratar|`
  + String.raw`quero contratar|aceito|autorizo|autorizado|prossiga|manda ver|ok pode|de acordo|yes|confirm)\b`);
const refusal = pedido => ({ ok: false, recusa: true, pedido, erro: 'o sim é do humano: a co-apresentadora não confirma nem aprova' });
export const humanOnly = { click: t => HUMAN_CLICK.test(plain(t)), text: t => HUMAN_TEXT.test(plain(t)) };

// uma ferramenta por nome, com os mesmos nomes que a assistente conhece (agent.mjs)
export async function run(name, args = {}) {
  switch (name) {
    case 'proximo_slide': return key('ArrowRight');
    case 'slide_anterior': return key('ArrowLeft');
    case 'ir_para_slide': {
      const p = await deckPage();
      if (args.nome && await p.evaluate(() => !!window.deck?.goName)) {
        const n = await p.evaluate(nome => window.deck.goName(nome), String(args.nome));
        if (!n) throw new Error(`não achei o slide "${args.nome}"`);
        return { ok: true, slide: await slideState(p) };
      }
      if (!args.numero) throw new Error('diga o número ou o nome do slide');
      if (await p.evaluate(() => !!window.deck?.go)) {
        await p.evaluate(n => window.deck.go(n - 1), Number(args.numero));
        return { ok: true, slide: await slideState(p) };
      }
      await key('Home');
      return key('ArrowRight', Math.max(0, Number(args.numero) - 1));
    }
    case 'explicar_slide': {
      // zera os passos do slide (ou vai para o próximo) e devolve as falas preparadas; o painel lê uma por passo
      const p = await deckPage();
      if (!await p.evaluate(() => !!window.deck?.guia)) throw new Error('este deck não tem explicação guiada');
      const g = await p.evaluate(prox => window.deck.guia(prox), !!args.proximo);
      if (!g.partes.some(Boolean)) throw new Error('este slide não tem explicação preparada');
      return { ok: true, slide: await slideState(p), intro: g.intro, partes: g.partes };
    }
    case 'mostrar_slides': return open();
    case 'mostrar_aba': return showTab(args.aba);
    case 'abrir_pagina': {
      const p = await demoPage(args.url || urls.demo);
      return { ok: true, titulo: await p.title(), url: p.url() };
    }
    case 'clicar': {
      if (humanOnly.click(args.alvo)) return refusal(`clicar em "${args.alvo}"`);
      const p = await demoPage();
      await clickEl(p, await find(p, args.alvo));
      return { ok: true, url: p.url() };
    }
    case 'preencher': {
      if (humanOnly.text(args.valor)) return refusal(`digitar "${args.valor}"`);
      const p = await demoPage();
      await fillEl(p, await find(p, args.campo), args.valor);
      return { ok: true };
    }
    case 'selecionar': {
      const p = await demoPage();
      return { ok: true, escolhida: await selectEl(p, await find(p, args.campo), args.opcao) };
    }
    case 'ler_tela': return { ok: true, ...(await readScreen(await demoPage())) };
    case 'executar_roteiro':
      if (/^(perguntar_banco|iniciar_demo|reiniciar_demo)$/.test(args.roteiro) && humanOnly.text(args.pergunta)) return refusal(`digitar "${args.pergunta}" no chat do banco`);
      if (args.roteiro === 'abrir_conta') return scriptOpenAccount(args.nome || undefined);
      if (args.roteiro === 'perguntar_banco') return scriptAskBank(args.cliente, args.pergunta);
      if (args.roteiro === 'iniciar_demo' || args.roteiro === 'reiniciar_demo') return scriptStartBank(args.cliente || 'Ana', args.pergunta || 'Qual o meu saldo?');
      if (args.roteiro === 'pedir_emprestimo') return scriptLoan(args.valor || 20000, args.prazo || 24);
      if (args.roteiro === 'situacao_emprestimo') return { ok: true, ...loanStatus };
      if (args.roteiro === 'observatorio') {
        const p = await obsPage();
        return { ok: true, titulo: await p.title(), url: p.url() };
      }
      throw new Error(`roteiro desconhecido: ${args.roteiro}`);
    default: throw new Error(`ferramenta desconhecida: ${name}`);
  }
}

// para testes e capturas de tela
export const pages = () => ({ deck, demo, obs, sre });

// só para os testes: preparar o chat sem enviar nada (não gasta o modelo)
export const _bankReady = bankReady;
