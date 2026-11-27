// stage.mjs — the "stage window": a Playwright-driven browser with the slides and the demo page.
// This is the window you share in Meet.
// The assistant acts here like a user: the cursor moves to the target, clicks and types key by key.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { PHRASES, LANGUAGE } from './agent.mjs';

const HEADLESS = process.env.HEADLESS === '1';
const CHANNEL = process.env.BROWSER_CHANNEL || undefined;   // 'chrome' uses the installed Google Chrome
// typing at an average person's pace: ~40 words per minute (200 characters/min, 300 ms per key)
const TYPE_WPM = Number(process.env.TYPE_WPM || 40);
const CURSOR_STEPS = Number(process.env.CURSOR_STEPS || 16);   // fewer steps = faster cursor

// What the Agentic Bank scripts type into the bank chat. The bank demo is a pt-BR app, so the defaults are Portuguese.
const BANK = {
  balance: process.env.BANK_BALANCE_QUESTION || 'Qual o meu saldo?',
  loan: (amount, term) => (process.env.BANK_LOAN_REQUEST || 'Quero pedir um empréstimo de R$ {amount} em {term} meses.')
    .replace('{amount}', Number(amount).toLocaleString('pt-BR')).replace('{term}', term),
  accept: process.env.BANK_ACCEPT_OFFER || 'Quero contratar essa oferta.',
  send: 'Enviar',   // the bank chat's send button
};
// The deck's own API (window.deck.*) names the apps in Portuguese: banco, sre, observatorio.
const DECK_APP = { bank: 'banco', sre: 'sre', observatory: 'observatorio' };

let browser, context, deck, demo, obs, sre;
let urls = { deck: '', demo: '' };
export const configure = u => { urls = u; };
export const targets = () => ({ ...urls });
// switches the demo URLs with the stage open (console buttons: local or OpenShift). Open tabs follow the new URLs.
export async function retarget(u) {
  const old = urls;
  urls = { ...urls, ...Object.fromEntries(Object.entries(u).filter(([, v]) => typeof v === 'string')) };
  if (demo && !demo.isClosed() && urls.demo && urls.demo !== old.demo) await demo.goto(urls.demo).catch(() => {});
  if (sre && !sre.isClosed() && urls.sre !== old.sre) {
    if (urls.sre) await sre.goto(urls.sre).catch(() => {}); else { await sre.close().catch(() => {}); sre = undefined; }
  }
  if (obs && !obs.isClosed() && urls.demo !== old.demo) { await obs.close().catch(() => {}); obs = undefined; }
  if (deck && !deck.isClosed()) { await pushTargets(); await deck.bringToFront().catch(() => {}); }
  return targets();
}

// visible cursor: Playwright mouse events are real, so the dot follows the movement
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
    // inside an iframe (demo embedded in the deck) the inner page draws the cursor
    addEventListener('mouseover', e => { if (e.target.tagName === 'IFRAME') { c.style.left = '-40px'; c.style.top = '-40px'; } }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', add); else add();
})();`;

async function ensureContext() {
  if (context && browser?.isConnected()) return context;
  browser = await chromium.launch({ headless: HEADLESS, channel: CHANNEL, args: ['--start-maximized'] });
  context = await browser.newContext({ viewport: HEADLESS ? { width: 1280, height: 800 } : null, ...(LANGUAGE === 'auto' ? {} : { locale: LANGUAGE }) });
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
    await pushTargets();
  }
  await deck.bringToFront();
  return deck;
}

// ---- demo embedded in the deck ----
// A deck with window.deck.vivo hosts the bank, the SRE Panel and the Observatory in windows (iframes) inside the slides.
// Then there are no tabs: scripts act inside the iframe, and mouse and keyboard are still the deck page's.
async function embedded() {
  if (!deck || deck.isClosed()) await deckPage();
  return deck.evaluate(() => !!window.deck?.vivo).catch(() => false);
}
// the deck learns where the bank and the SRE Panel are (DEMO_URL/SRE_URL or the console); it never mixes local and cluster
async function pushTargets() {
  if (!deck || deck.isClosed() || !urls.demo) return;
  await deck.evaluate(u => window.deck?.alvos?.(u), { demo: urls.demo, sre: urls.sre }).catch(() => {});
}
// keys go back to the slides after a script typed inside an iframe
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
// app: bank, sre or observatory. show=false keeps the current slide on screen (the loan runs behind it).
async function liveFrame(app, show = true) {
  const p = await deckPage();
  const key = DECK_APP[app];
  const info = await p.evaluate(([a, m]) => window.deck.vivo(a, m), [key, show]);
  if (!info || !info.url) throw new Error(`${app}: no address in environment ${info?.ambiente || ''} (Local/OpenShift picker in the window bar)`);
  const h = await p.locator(`.livewin[data-app="${key}"] iframe`).elementHandle();
  const f = await h.contentFrame();
  if (!f) throw new Error(`${app}: the window has not loaded yet`);
  await f.waitForLoadState('domcontentloaded').catch(() => {});
  return asPage(p, f, info.url);
}

async function demoPage(url, front = true) {
  if (await embedded()) {
    const p = await liveFrame('bank', front);
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

// SRE Panel: third fixed stage tab (SRE_URL). Comes to the front only when asked.
async function srePage(front = true) {
  if (await embedded()) return liveFrame('sre', front);
  if (!urls.sre) throw new Error('SRE Panel not configured (SRE_URL)');
  await ensureContext();
  if (!sre || sre.isClosed()) {
    sre = await context.newPage();
    sre.on('load', () => paintBadge(sre));
    await sre.goto(urls.sre);
  }
  if (front) await sre.bringToFront();
  return sre;
}

// Observatory in its own tab: the bank chat stays alive in the bank tab
async function obsPage() {
  if (await embedded()) return liveFrame('observatory');
  await ensureContext();
  if (!obs || obs.isClosed()) {
    obs = await context.newPage();
    obs.on('load', () => paintBadge(obs));
    await obs.goto(new URL('/observatory', urls.demo).href);
  }
  await obs.bringToFront();
  return obs;
}

// the current slide: a deck may expose window.deck.state() (Portuguese or English fields); any other deck falls back
// to the visible title
async function slideState(p) {
  const s = await p.evaluate(() => {
    if (window.deck?.state) return window.deck.state();
    const h = document.querySelector('.slide.active h1, .slide.active h2, h1, h2');
    return { title: h ? h.textContent.trim().replace(/\s+/g, ' ') : document.title };
  });
  return { ...s, number: s.number ?? s.numero, title: s.title ?? s.titulo, notes: s.notes ?? s.notas, step: s.step ?? s.passo };
}

async function key(k, times = 1) {
  const p = await deckPage();
  await releaseKeys();
  for (let i = 0; i < times; i++) { await p.keyboard.press(k); await p.waitForTimeout(60); }
  await p.waitForLoadState('domcontentloaded');   // one-page-per-slide decks navigate on each key
  return { ok: true, slide: await slideState(p) };
}

// finds the element by what a person would say: label, button or link name, placeholder, text
async function find(p, target) {
  const candidates = [
    p.getByLabel(target), p.getByRole('button', { name: target }), p.getByRole('link', { name: target }),
    p.getByPlaceholder(target), p.getByText(target),
  ];
  for (const c of candidates) {
    const el = c.first();
    if (await el.count() && await el.isVisible().catch(() => false)) return el;
  }
  throw new Error(`could not find "${target}" on screen`);
}

async function moveTo(p, el) {
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  if (!b) throw new Error('the element is not visible');
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

// one key at a time, with a human's uneven rhythm: ±45% and a pause after spaces and punctuation
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

async function fillEl(p, el, value) {
  await clickEl(p, el);
  await el.fill('');
  await typeHuman(p, value);
}

async function selectEl(p, el, option) {
  await moveTo(p, el);
  const options = await el.locator('option').allTextContents();
  const want = option.toLowerCase();
  const label = options.find(o => o.toLowerCase() === want) || options.find(o => o.toLowerCase().includes(want));
  if (!label) throw new Error(`the list has no "${option}". Options: ${options.join(', ')}`);
  await el.selectOption({ label });
  await p.waitForTimeout(250);
  return label;
}

async function readScreen(p) {
  return p.evaluate(() => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const labelOf = el => (el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.placeholder || el.name || '').trim();
    const fields = [...document.querySelectorAll('input, select, textarea')].filter(vis)
      .map(el => ({ field: labelOf(el), type: el.type || el.tagName.toLowerCase(), value: el.type === 'checkbox' ? el.checked : el.value }));
    const buttons = [...document.querySelectorAll('button, a[href], [role=button]')].filter(vis)
      .map(el => el.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 30);
    const text = document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 1800);
    return { title: document.title, url: location.href, fields, buttons, text, badge: document.getElementById('__caliope_badge')?.textContent || null };
  });
}

// test Demo Bank (public/demo)
const SAMPLE = { email: 'maria.oliveira@example.com', income: '8500', product: 'Digital account + card' };

async function scriptOpenAccount(name = 'Maria Oliveira') {
  const p = await demoPage(urls.demo);
  await p.waitForTimeout(600);
  await fillEl(p, await find(p, 'Full name'), name);
  const email = name === 'Maria Oliveira' ? SAMPLE.email
    : name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, '.') + '@example.com';
  await fillEl(p, await find(p, 'Email'), email);
  await fillEl(p, await find(p, 'Monthly income'), SAMPLE.income);
  await selectEl(p, await find(p, 'Product'), SAMPLE.product);
  await clickEl(p, await find(p, 'I have read and accept the terms'));
  await clickEl(p, await find(p, 'Open account'));
  const done = p.getByTestId('result');
  await done.waitFor({ state: 'visible', timeout: 8000 });
  return { ok: true, result: (await done.innerText()).replace(/\s+/g, ' ').trim() };
}

// Agentic Bank: opens the bank as the given customer, chat open. Never reloads the page, to keep the chat.
async function bankReady(customer, { reload = false, front = true } = {}) {
  const p = await demoPage(undefined, front);
  if (reload || !await p.locator('#customerPicker').count()) await p.goto(p.home || urls.demo);
  await p.waitForSelector('#customerPicker');
  await p.waitForFunction(() => document.getElementById('customerPicker').options.length > 0);
  if (customer) {
    const picker = p.locator('#customerPicker');
    const current = await picker.evaluate(e => e.selectedOptions[0]?.text || '');
    // switching customer reloads the page (?customer=...)
    if (!current.toLowerCase().includes(customer.toLowerCase())) {
      await Promise.all([p.waitForNavigation({ waitUntil: 'load' }), selectEl(p, picker, customer)]);
      await p.waitForSelector('#customerPicker');
      await p.waitForFunction(() => document.getElementById('customerPicker').options.length > 0);
    }
  }
  // the chat is in the page even with the panel closed: the class says whether it is open
  if (!await p.locator('#floatPanel.panel-open').count()) {
    // behind another slide (embedded demo) a mouse click would land on the front window: click through the DOM
    if (front) await clickEl(p, p.locator('#floatToggle')); else await p.locator('#floatToggle').dispatchEvent('click');
    await p.waitForTimeout(450);
  }
  await p.locator('#q').waitFor({ state: 'visible', timeout: 5000 });
  return p;
}

// every new question starts a new chat: the Observatory shows only this question's hops
async function newChat(p, human = true) {
  const btn = p.locator('#newChat');
  if (!await btn.isVisible().catch(() => false)) return;
  if (human) await clickEl(p, btn); else await btn.dispatchEvent('click');
  await p.waitForTimeout(300);
}

async function scriptAskBank(customer, question) {
  const p = await bankReady(customer);
  await newChat(p);
  await fillEl(p, p.locator('#q'), question);
  await clickEl(p, p.getByRole('button', { name: BANK.send }));
  await releaseKeys();
  return { ok: true, sent: question, customer: customer || 'current customer' };
}

// "Calíope, start the demo" and "restart the demo": bank reloaded, new chat, and the balance question
async function scriptStartBank(customer = 'Ana', question = BANK.balance) {
  const p = await bankReady(customer, { reload: true });
  await newChat(p);
  await fillEl(p, p.locator('#q'), question);
  await clickEl(p, p.getByRole('button', { name: BANK.send }));
  await releaseKeys();
  return { ok: true, sent: question, customer, chat: 'new' };
}

// "Calíope, continue": requests the loan in the bank chat, in the bank tab, without taking the Observatory off screen.
// When the offer comes, asks to take it; stops when the bank asks for the customer's confirmation (the human click).
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
export let loanStatus = { phase: 'idle' };
// bank replies (pt-BR app; English alternatives too)
const asksConfirm = t => /confirm|autoriz|authori|\bsim\b|\byes\b|posso (prosseguir|contratar|seguir)|deseja (contratar|prosseguir)|shall i proceed|do you want to (proceed|take)/i.test(t) && /\?/.test(t);
const isOffer = t => /oferta|parcela|aprovad|liberad|taxa|offer|installment|approved|rate/i.test(t);
async function loanFlow(p, before, amount) {
  try {
    loanStatus = { phase: 'request sent, waiting for the offer', amount };
    let reply = await waitReply(p, before);
    loanStatus = { phase: 'offer received', reply };
    console.log(`  loan · reply 1: ${reply.slice(0, 160)}`);
    if (!asksConfirm(reply) && isOffer(reply)) {
      const b2 = await sendInBackground(p, BANK.accept);
      loanStatus = { phase: 'asked to take the offer, waiting for the confirmation' };
      reply = await waitReply(p, b2);
      console.log(`  loan · reply 2: ${reply.slice(0, 160)}`);
    }
    loanStatus = asksConfirm(reply)
      ? { phase: 'waiting for human confirmation (INPUT_REQUIRED)', reply }
      : { phase: 'stopped without a confirmation request: check the chat', reply };
  } catch (e) {
    loanStatus = { phase: 'failed', error: e.message.split('\n')[0] };
  }
  console.log(`  loan · ${loanStatus.phase}`);
}
async function scriptLoan(amount = 20000, term = 24) {
  const p = await bankReady(null, { front: false });
  const request = BANK.loan(amount, term);
  await newChat(p, false);   // new chat for the request; "take the offer" continues in it
  const before = await sendInBackground(p, request);
  loanFlow(p, before, amount);   // continues by itself; the tool result does not wait for the model
  return { ok: true, sent: request, continues: 'in the bank chat, in the background, until the customer confirmation request' };
}

// discreet badge in the stage window corner: the audience sees she is listening, and you know whether to call her
let badge = { state: 'off', name: 'Calíope' };
async function paintBadge(p) {
  if (!p || p.isClosed()) return;
  const fill = s => s.replaceAll('{name}', badge.name);
  await p.evaluate(({ state, listening, asleep }) => {
    let b = document.getElementById('__caliope_badge');
    if (state === 'off') { b?.remove(); return; }
    if (!b) {
      b = document.createElement('div');
      b.id = '__caliope_badge';
      b.style.cssText = 'position:fixed;right:18px;top:14px;z-index:2147483646;display:flex;align-items:center;gap:8px;'
        + 'padding:7px 13px 7px 10px;border-radius:99px;font:600 13px/1 Inter,system-ui,sans-serif;pointer-events:none;'
        + 'backdrop-filter:blur(6px);transition:all .3s;';
      b.innerHTML = '<i style="width:10px;height:10px;border-radius:50%;display:block"></i><span></span>';
      document.documentElement.appendChild(b);
    }
    const on = state === 'awake';
    b.style.background = on ? 'rgba(22,163,74,.88)' : 'rgba(40,40,46,.78)';
    b.style.color = '#fff';
    b.querySelector('i').style.background = on ? '#bbf7d0' : '#9ca3af';
    b.querySelector('span').textContent = on ? listening : asleep;
  }, { state: badge.state, listening: fill(PHRASES.listening), asleep: fill(PHRASES.asleep) }).catch(() => {});
}
export async function setBadge(state, name) {
  badge = { state, name: name || badge.name };
  await Promise.all([deck, demo, obs, sre].map(paintBadge));
  return { ok: true };
}

// voice spectrum over the stage tabs, only while she speaks (public/spectrum.js).
// The panel says when she starts and stops speaking; each tab animates by itself.
// The file is re-read on every call: a visual change applies on the next utterance, without restarting the server.
// A new version replaces the one already injected in the tab (destroy).
export async function spectrum(msg) {
  const src = readFileSync(new URL('./public/spectrum.js', import.meta.url), 'utf8');
  let h = 0; for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0;
  const all = [deck, demo, obs, sre].filter(p => p && !p.isClosed());
  const js = `if (window.__caliSpectrum?.v !== ${h}) { try { window.__caliSpectrum?.destroy?.(); } catch {} `
    + `document.getElementById('__cali_spectrum')?.remove(); window.__caliSpectrum = undefined;\n${src}\n;window.__caliSpectrum.v = ${h}; }\n`
    + `window.__caliSpectrum.cmd(${JSON.stringify(msg)})`;
  await Promise.all(all.map(p => p.evaluate(js).catch(() => {})));
  return { ok: true, tabs: all.length };
}

// The demo console mirrors a cluster scene result here (the Seguros 403, the Credit budget): the deck shows it in a
// card over the current slide (window.deck.cena). With the stage closed, or a deck that does not know scenes,
// nothing happens: the result stays in the console.
export async function scene(c) {
  if (!deck || deck.isClosed()) return { ok: true, shown: false, reason: 'stage closed' };
  const shown = await deck.evaluate(x => (window.deck?.cena ? (window.deck.cena(x), true) : false), c).catch(() => false);
  return shown ? { ok: true, shown } : { ok: true, shown, reason: 'this deck does not show scenes' };
}

// opening the stage creates the tabs in the talk's order: Presentation, Agentic Bank, SRE Panel.
// They stay open; asking for the demo or the slides only switches the front tab, reloading nothing.
export async function open() {
  const p = await deckPage();
  if (await embedded()) return { ok: true, slide: await slideState(p) };   // bank and SRE Panel live in the slides
  if (!demo || demo.isClosed()) {
    demo = await context.newPage();
    demo.on('load', () => paintBadge(demo));
    await demo.goto(urls.demo).catch(e => console.log(`  bank tab: ${e.message.split('\n')[0]}`));
  }
  if (urls.sre && (!sre || sre.isClosed())) await srePage(false).catch(e => console.log(`  SRE Panel tab: ${e.message.split('\n')[0]}`));
  await p.bringToFront();
  return { ok: true, slide: await slideState(p) };
}

async function showTab(tab) {
  const a = String(tab || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const isSlides = /present|apresent|slide/.test(a);
  const app = /sre|painel|panel/.test(a) ? 'sre' : /observ/.test(a) ? 'observatory' : /banco|demo|bank/.test(a) ? 'bank' : '';
  if (await embedded()) {
    if (isSlides) {
      const p = await deckPage();
      await p.evaluate(() => window.deck.voltar());
      return { ok: true, slide: await slideState(p) };
    }
    if (!app) throw new Error(`unknown tab "${tab}"`);
    const f = await liveFrame(app);
    return { ok: true, slide: await slideState(deck), url: f.url() };
  }
  if (isSlides) return open();
  if (app === 'sre') {
    const p = await srePage();
    // only brings the tab to the front: your first click on the page wakes the sre-agent
    return { ok: true, tab: 'SRE Panel', url: p.url() };
  }
  if (app === 'observatory') { const p = await obsPage(); return { ok: true, tab: 'Observatory', url: p.url() }; }
  if (app === 'bank') { const p = await demoPage(); return { ok: true, tab: 'Agentic Bank', url: p.url() }; }
  throw new Error(`unknown tab "${tab}"`);
}

export async function close() {
  await browser?.close().catch(() => {});
  browser = context = deck = demo = obs = sre = undefined;
  return { ok: true };
}

// ---- the "yes" belongs to the human ----
// The co-presenter never confirms, approves or authorizes anything in the demo, even when asked. The free tools refuse
// a click on a confirm or approve button, and refuse typing what the bank counts as the customer's "yes"
// (the bank's list: AFFIRMATIVE in OpenAiCompatResource.java, plus English). The loan script does not go through here:
// it requests the offer and stops by itself at the confirmation request.
// HUMAN_ONLY_CLICK and HUMAN_ONLY_TEXT in the environment replace the lists (regular expressions on accent-free text).
const plain = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^\p{L}\d\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const HUMAN_CLICK = new RegExp(process.env.HUMAN_ONLY_CLICK
  || String.raw`\b(confirm\w*|aprov\w*|approv\w*|autoriz\w*|authori\w*|aceit\w*|accept\w*|contrat\w*|efetiv\w*|sim|yes)\b`);
const HUMAN_TEXT = new RegExp(process.env.HUMAN_ONLY_TEXT
  || String.raw`\b(sim|confirmo|confirma|confirmar|confirmado|confirmada|pode executar|pode prosseguir|pode contratar|`
  + String.raw`quero contratar|aceito|autorizo|autorizado|prossiga|manda ver|ok pode|de acordo|yes|confirm|confirmed|`
  + String.raw`i confirm|i accept|i authorize|approved|go ahead|proceed)\b`);
const refusal = request => ({ ok: false, refused: true, request, error: 'the yes is human: the co-presenter does not confirm or approve' });
export const humanOnly = { click: t => HUMAN_CLICK.test(plain(t)), text: t => HUMAN_TEXT.test(plain(t)) };

// one tool by name, with the same names the assistant knows (agent.mjs)
export async function run(name, args = {}) {
  switch (name) {
    case 'next_slide': return key('ArrowRight');
    case 'previous_slide': return key('ArrowLeft');
    case 'go_to_slide': {
      const p = await deckPage();
      if (args.name && await p.evaluate(() => !!window.deck?.goName)) {
        const n = await p.evaluate(nome => window.deck.goName(nome), String(args.name));
        if (!n) throw new Error(`could not find slide "${args.name}"`);
        return { ok: true, slide: await slideState(p) };
      }
      if (!args.number) throw new Error('give the slide number or name');
      if (await p.evaluate(() => !!window.deck?.go)) {
        await p.evaluate(n => window.deck.go(n - 1), Number(args.number));
        return { ok: true, slide: await slideState(p) };
      }
      await key('Home');
      return key('ArrowRight', Math.max(0, Number(args.number) - 1));
    }
    case 'explain_slide': {
      // resets the slide's steps (or goes to the next slide) and returns the prepared lines; the panel reads one per step
      const p = await deckPage();
      if (!await p.evaluate(() => !!window.deck?.guia)) throw new Error('this deck has no guided explanation');
      const g = await p.evaluate(next => window.deck.guia(next), !!args.next);
      const parts = g.parts || g.partes || [];
      if (!parts.some(Boolean)) throw new Error('this slide has no prepared explanation');
      return { ok: true, slide: await slideState(p), intro: g.intro, parts };
    }
    case 'show_slides': return open();
    case 'show_tab': return showTab(args.tab);
    case 'open_page': {
      const p = await demoPage(args.url || urls.demo);
      return { ok: true, title: await p.title(), url: p.url() };
    }
    case 'click': {
      if (humanOnly.click(args.target)) return refusal(`click "${args.target}"`);
      const p = await demoPage();
      await clickEl(p, await find(p, args.target));
      return { ok: true, url: p.url() };
    }
    case 'fill': {
      if (humanOnly.text(args.value)) return refusal(`type "${args.value}"`);
      const p = await demoPage();
      await fillEl(p, await find(p, args.field), args.value);
      return { ok: true };
    }
    case 'select': {
      const p = await demoPage();
      return { ok: true, selected: await selectEl(p, await find(p, args.field), args.option) };
    }
    case 'read_screen': return { ok: true, ...(await readScreen(await demoPage())) };
    case 'run_script':
      if (/^(ask_bank|start_demo|restart_demo)$/.test(args.script) && humanOnly.text(args.question)) return refusal(`type "${args.question}" in the bank chat`);
      if (args.script === 'open_account') return scriptOpenAccount(args.name || undefined);
      if (args.script === 'ask_bank') return scriptAskBank(args.customer, args.question);
      if (args.script === 'start_demo' || args.script === 'restart_demo') return scriptStartBank(args.customer || 'Ana', args.question || BANK.balance);
      if (args.script === 'request_loan') return scriptLoan(args.amount || 20000, args.term || 24);
      if (args.script === 'loan_status') return { ok: true, ...loanStatus };
      if (args.script === 'observatory') {
        const p = await obsPage();
        return { ok: true, title: await p.title(), url: p.url() };
      }
      throw new Error(`unknown script: ${args.script}`);
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// for tests and screenshots
export const pages = () => ({ deck, demo, obs, sre });

// tests only: prepare the chat without sending anything (costs no model call)
export const _bankReady = bankReady;
