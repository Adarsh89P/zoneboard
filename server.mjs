// ZoneBoard: a public site, sign-in, paid plans, and the live order-block board for members.
//   Live:     see README for the environment (Kite, Google, Razorpay, SESSION_SECRET).
//   Snapshot: DEV_LOGIN=1 node server.mjs --snapshot data/board-2026-11-17.json   (no Kite, Google or Razorpay)
// Members get the live board pushed over Server-Sent Events every minute while the market is
// open (09:15–15:30 IST, Mon–Fri; exchange holidays are not known to it). Everyone else gets a
// made-up sample board, so real data never reaches a visitor without a plan.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Kite } from './src/kite.mjs';
import crypto from 'node:crypto';
import { scoreStock, rankBoard, dailyStats, zones, oiDrift } from './src/engine.mjs';
import { Accounts, google, cookie, cookies, randomToken } from './src/accounts.mjs';
import { Razorpay, plans } from './src/payments.mjs';
import { sampleBoard } from './src/sample.mjs';
import { makePlan, advance, pickOption } from './src/plans.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = +(process.env.PORT || 8080);
const TOP = 20;          // rows per side on the board
const ZONED = 10;        // rows per side that get 5-minute candles and zones each minute
const args = process.argv.slice(2);
// --snapshot FILE, or BOARD_SNAPSHOT: show a saved board instead of a live one (a deployment
// without Kite keys yet). Live Kite always wins once KITE_API_KEY is set.
const snapshotFile = args.includes('--snapshot') ? args[args.indexOf('--snapshot') + 1]
  : !process.env.KITE_API_KEY && process.env.BOARD_SNAPSHOT ? process.env.BOARD_SNAPSHOT : null;

fs.mkdirSync(DATA, { recursive: true });

/* ── time (IST) ─────────────────────────────────────────────────────── */
const ist = (d = new Date()) => new Date(d.getTime() + 330 * 60e3);
const ymd = (d = new Date()) => ist(d).toISOString().slice(0, 10);
const daysAgo = (n) => ymd(new Date(Date.now() - n * 864e5));
function market(now = new Date()) {
  const t = ist(now), wd = t.getUTCDay(), m = t.getUTCHours() * 60 + t.getUTCMinutes();
  if (wd === 0 || wd === 6) return { state: 'closed', label: 'Market closed · weekend' };
  if (m < 9 * 60) return { state: 'closed', label: 'Opens 09:15' };
  if (m < 9 * 60 + 15) return { state: 'pre', label: 'Opens 09:15' };
  if (m <= 15 * 60 + 30) return { state: 'open', label: 'Market open' };
  return { state: 'closed', label: 'Market closed' };
}

/* ── state ──────────────────────────────────────────────────────────── */
let board = snapshotFile ? JSON.parse(fs.readFileSync(snapshotFile, 'utf8')) : null;
// A saved board that is rewritten (by scripts/snapshot.mjs) is pushed to open pages at once.
if (snapshotFile) fs.watchFile(snapshotFile, { interval: 1000 }, () => {
  try { board = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')); push('board', board); } catch { /* mid-write; the next change catches it */ }
});
let status = snapshotFile ? 'snapshot' : 'signed_out';
let note = snapshotFile ? `Saved board from ${path.basename(snapshotFile)}` : 'Sign in with Zerodha to start';
const clients = new Set();

const kite = new Kite(process.env.KITE_API_KEY || '', process.env.KITE_API_SECRET || '');
const tokenFile = () => path.join(DATA, `token-${ymd()}.json`);
try { kite.accessToken = JSON.parse(fs.readFileSync(tokenFile(), 'utf8')).access_token; status = 'ready'; } catch { }

/** Board events go to members only; status goes to everyone. */
function push(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) if (event !== 'board' || c.member) c.res.write(msg);
}
function setStatus(s, n) { status = s; note = n; push('status', { status: s === 'signed_out' ? 'waiting' : s, note: '', market: market() }); }

/* ── daily preparation: ATR, average volume, yesterday's futures OI ───
 * About two calls per stock, paced to Kite's limit: a couple of minutes once
 * a day, cached so a restart the same day does not repeat it. */
let universe = null, daily = null, chains = null;
/** NIFTY and BANKNIFTY: their quote, candles and option chain names. */
const INDICES = [{ name: 'NIFTY', quote: 'NSE:NIFTY 50', token: 256265 }, { name: 'BANKNIFTY', quote: 'NSE:NIFTY BANK', token: 260105 }];
async function prepare() {
  const file = path.join(DATA, `prep-${ymd()}.json`);
  try { ({ universe, daily, chains } = JSON.parse(fs.readFileSync(file, 'utf8'))); if (chains) return; } catch { }
  setStatus('preparing', 'Loading the F&O list');
  universe = await kite.fnoUniverse();
  chains = kite.optionChains([...universe.map((u) => u.name), ...INDICES.map((i) => i.name)]);
  daily = {};
  const today = ymd();
  for (let i = 0; i < universe.length; i++) {
    const u = universe[i];
    setStatus('preparing', `Reading history ${i + 1} of ${universe.length}: ${u.name}`);
    try {
      const days = (await kite.historical(u.token, 'day', daysAgo(45), daysAgo(1))).filter((c) => c.t.slice(0, 10) < today);
      // OI is summed over this month's and next month's future, so positions rolled forward
      // in expiry week still count as open
      let prevOi = 0;
      for (const t of [u.fut_token, u.fut2_token].filter(Boolean)) {
        const fut = (await kite.historical(t, 'day', daysAgo(7), daysAgo(1), true)).filter((c) => c.t.slice(0, 10) < today);
        prevOi += fut.at(-1)?.oi || 0;
      }
      daily[u.name] = { ...dailyStats(days.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v])), prevOi: prevOi || undefined };
    } catch (e) {
      if (e.status === 403) throw e; // session gone: stop and ask for sign-in
      daily[u.name] = {};
    }
  }
  fs.writeFileSync(file, JSON.stringify({ universe, daily, chains }));
}

/* ── today's plans: one per stock or index per day, kept across restarts ── */
let planDay = '', tradePlans = new Map();
function loadPlans() {
  if (planDay === ymd()) return;
  planDay = ymd(); tradePlans = new Map();
  try { for (const p of JSON.parse(fs.readFileSync(path.join(DATA, `plans-${planDay}.json`), 'utf8'))) tradePlans.set(p.name, p); } catch { }
}
const savePlans = () => fs.writeFileSync(path.join(DATA, `plans-${planDay}.json`), JSON.stringify([...tradePlans.values()]));
const open = (p) => p.status === 'waiting' || p.status === 'active';
const fiveMin = async (token) => {
  const c = await kite.historical(token, '5minute', daysAgo(5), ymd() + ' 23:59:59');
  const days = [...new Set(c.map((x) => x.t.slice(0, 10)))].slice(-2);
  return c.filter((x) => days.includes(x.t.slice(0, 10)));
};
/** Makes a plan for a row the first time it has a setup today, and moves every plan on. */
function track(row, candles) {
  const todays = candles.filter((x) => x.t.startsWith(ymd()));
  let p = tradePlans.get(row.name);
  if (!p && row.dir && todays.length) {
    p = makePlan(row, candles);
    if (p) { p.option = pickOption(chains?.[row.name], row.ltp, p.side, ymd()); tradePlans.set(row.name, p); }
  } else if (p && open(p)) advance(p, todays);
}
let backtest = null;
try { const b = JSON.parse(fs.readFileSync(path.join(DATA, 'backtest.json'), 'utf8')); backtest = { ...b.summary, sessions: new Set(b.trades.map((t) => t.day)).size }; } catch { }

/* ── one scan ───────────────────────────────────────────────────────── */
async function scan() {
  loadPlans();
  const q = await kite.quote([...INDICES.map((i) => i.quote), ...universe.flatMap((u) => ['NSE:' + u.name, 'NFO:' + u.fut, ...(u.fut2 ? ['NFO:' + u.fut2] : [])])]);
  const oiNow = (u) => (q['NFO:' + u.fut]?.oi || 0) + (u.fut2 ? q['NFO:' + u.fut2]?.oi || 0 : 0) || undefined;
  const drift = oiDrift(universe.map((u) => ({ oi: oiNow(u), prevOi: daily[u.name]?.prevOi })));
  const rows = [];
  for (const u of universe) {
    const s = q['NSE:' + u.name];
    if (!s?.ohlc) continue;
    const d = daily[u.name] || {};
    rows.push({
      name: u.name, ltp: s.last_price, token: u.token,
      ...scoreStock({ ltp: s.last_price, prevClose: s.ohlc.close, open: s.ohlc.open, high: s.ohlc.high, low: s.ohlc.low,
        volume: s.volume, avgVolume: d.avgVolume, atrPct: d.atrPct, oi: oiNow(u), prevOi: d.prevOi, oiDrift: drift }),
    });
  }
  const ranked = rankBoard(rows, TOP);
  // zones for the strongest few each side: today's and the previous session's 5-minute candles
  const zoned = [...ranked.bull.slice(0, ZONED), ...ranked.bear.slice(0, ZONED)];
  for (const r of zoned) {
    try {
      const recent = await fiveMin(r.token);
      r.zones = zones(recent, r.dir, r.ltp);
      r.candles = recent.slice(-75).map((x) => [x.t, x.o, x.h, x.l, x.c]);
      track(r, recent);
    } catch { /* the row stays on the board without its chart */ }
  }
  // plans for stocks that have since dropped off the board still need watching
  for (const p of tradePlans.values()) {
    if (!open(p) || zoned.some((r) => r.name === p.name) || INDICES.some((i) => i.name === p.name)) continue;
    const u = universe.find((x) => x.name === p.name);
    try { if (u) advance(p, (await fiveMin(u.token)).filter((x) => x.t.startsWith(ymd()))); } catch { }
  }
  // NIFTY and BANKNIFTY: a direction only when the index and the market's breadth agree
  const indices = [];
  for (const ix of INDICES) {
    const s = q[ix.quote];
    if (!s?.ohlc) continue;
    const chgPct = Math.round(((s.last_price - s.ohlc.close) / s.ohlc.close) * 10000) / 100;
    const breadth = ranked.counts.bullish - ranked.counts.bearish;
    const dir = chgPct > 0.15 && breadth > 0 ? 1 : chgPct < -0.15 && breadth < 0 ? -1 : 0;
    const row = { name: ix.name, ltp: s.last_price, chgPct, dir, bias: dir > 0 ? 'Bullish' : dir < 0 ? 'Bearish' : 'Mixed' };
    try {
      const recent = await fiveMin(ix.token);
      row.zones = dir ? zones(recent, dir, s.last_price) : null;
      row.candles = recent.slice(-75).map((x) => [x.t, x.o, x.h, x.l, x.c]);
      track(row, recent);
    } catch { }
    indices.push(row);
  }
  // the option each live plan names, priced now
  const opts = [...tradePlans.values()].filter((p) => open(p) && p.option).map((p) => 'NFO:' + p.option.symbol);
  if (opts.length) { try { const oq = await kite.quote(opts); for (const p of tradePlans.values()) if (p.option && oq['NFO:' + p.option.symbol]) p.option.ltp = oq['NFO:' + p.option.symbol].last_price; } catch { } }
  savePlans();
  const strip = ({ token, parts, ...r }) => r;
  board = {
    asOf: new Date().toISOString(), market: market(), oiDrift: Math.round(drift * 100) / 100,
    bull: ranked.bull.map(strip), bear: ranked.bear.map(strip), counts: ranked.counts,
    indices, plans: [...tradePlans.values()], backtest,
    all: rows.map(({ name, chgPct, score, dir }) => ({ name, chgPct, score, dir })),
  };
  fs.writeFileSync(path.join(DATA, `board-${ymd()}.json`), JSON.stringify(board));
  push('board', board);
}

let running = false;
async function loop() {
  if (running || snapshotFile || !kite.accessToken) return;
  running = true;
  try {
    if (!universe) await prepare();
    const m = market();
    if (m.state === 'open' || !board) { setStatus('live', m.state === 'open' ? 'Live' : 'Last session'); await scan(); }
    push('status', { status, note: '', market: m });
  } catch (e) {
    if (e.status === 403) { kite.accessToken = ''; universe = null; setStatus('signed_out', 'Zerodha session ended. Sign in again'); }
    else setStatus('error', e.message);
  } finally { running = false; }
}
setInterval(loop, 60e3);
loop();

/* ── site configuration ─────────────────────────────────────────────── */
const SITE = process.env.SITE_NAME || 'ZoneBoard';
const BASE = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE = BASE.startsWith('https://');
const DEV_LOGIN = process.env.DEV_LOGIN === '1';
// No payments yet: every signed-in user gets the full board, and the pricing parts of the site are hidden.
const OPEN_ACCESS = process.env.OPEN_ACCESS === '1';
// Sign-in with one shared password, for a private deployment without Google set up.
// Trimmed: a password pasted into a hosting dashboard easily picks up a trailing space or newline.
const SITE_PASSWORD = (process.env.SITE_PASSWORD || '').trim();
const ADMIN = (process.env.ADMIN_EMAIL || '').toLowerCase();
const G = { clientId: process.env.GOOGLE_CLIENT_ID || '', clientSecret: process.env.GOOGLE_CLIENT_SECRET || '', redirectUri: BASE + '/auth/google/callback' };
const pay = new Razorpay(process.env.RAZORPAY_KEY_ID || '', process.env.RAZORPAY_KEY_SECRET || '');
const PLANS = plans();

// A missing secret is made once and kept, so sessions survive restarts on a dev machine.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA, 'session-secret');
  try { return fs.readFileSync(f, 'utf8'); } catch { }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const accounts = new Accounts({ file: path.join(DATA, 'users.json'), secret: sessionSecret() });

// orders started but not yet paid, so a verified payment maps to the right user and plan
const ordersFile = path.join(DATA, 'orders.json');
let orders = {}; try { orders = JSON.parse(fs.readFileSync(ordersFile, 'utf8')); } catch { }
const saveOrders = () => fs.writeFileSync(ordersFile, JSON.stringify(orders));

const isAdmin = (u) => !!u && !!ADMIN && u.email === ADMIN;
const member = (u) => !!u && (OPEN_ACCESS || accounts.isMember(u));
// a few password tries per address per 10 minutes, so the password cannot be guessed by brute force
const tries = new Map();
function tooMany(ip) {
  const now = Date.now(), t = (tries.get(ip) || []).filter((x) => now - x < 600e3);
  t.push(now); tries.set(ip, t);
  return t.length > 8;
}

/* ── http helpers ───────────────────────────────────────────────────── */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://*.googleusercontent.com; connect-src 'self' https://*.razorpay.com; frame-src https://*.razorpay.com",
};
const json = (res, code, body, headers = {}) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(body));
const redirect = (res, to, headers = {}) => res.writeHead(302, { Location: to, ...headers }).end();
async function body(req) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 1e5) throw new Error('Too large'); }
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}
/** Double-submit check: a POST must echo the CSRF cookie in a header, which a cross-site form cannot do. */
const csrfOk = (req) => { const c = cookies(req).zb_csrf; return !!c && req.headers['x-csrf'] === c; };
const safeNext = (n) => (typeof n === 'string' && /^\/[a-z0-9/_-]*$/i.test(n) ? n : '/app');

/** Pages are plain HTML with {{KEY}} slots filled from here. */
function page(res, req, name, vars = {}, code = 200) {
  const csrf = cookies(req).zb_csrf || randomToken();
  let html = fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');
  const all = { SITE, YEAR: String(new Date().getFullYear()), ...vars };
  html = html.replace(/\{\{(\w+)\}\}/g, (_, k) => (all[k] ?? '').toString().replace(/[<>"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  res.writeHead(code, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store', 'Set-Cookie': cookie('zb_csrf', csrf, { secure: SECURE, httpOnly: false }), ...SECURITY });
  res.end(html);
}
function meOf(u) {
  return u && { email: u.email, name: u.name, picture: u.picture, member: member(u), paidUntil: u.paidUntil || 0, admin: isAdmin(u) };
}
const statusFor = (u) => ({ status: isAdmin(u) ? status : status === 'signed_out' ? 'waiting' : status, note: isAdmin(u) ? note : '', market: market() });

/* ── routes ─────────────────────────────────────────────────────────── */
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, user = accounts.userFrom(req);
  try {
    /* public pages */
    if (p === '/') return page(res, req, 'site/index.html', { PAID: OPEN_ACCESS ? '' : '1', PER_DAY: PLANS[1].perDay, YEARLY: PLANS[1].price.toLocaleString('en-IN'), MONTHLY: PLANS[0].price.toLocaleString('en-IN'), CTA: user ? '/app' : '/login' });
    if (['/terms', '/privacy', '/disclaimer', '/refunds'].includes(p)) return page(res, req, `site${p}.html`);
    if (p === '/login') {
      if (user) return redirect(res, safeNext(url.searchParams.get('next')));
      return page(res, req, 'site/login.html', { NEXT: safeNext(url.searchParams.get('next')), GOOGLE: G.clientId ? '1' : '', DEV: DEV_LOGIN ? '1' : '', PASSWORD: SITE_PASSWORD ? '1' : '', ERROR: url.searchParams.get('error') || '' });
    }

    /* sign-in */
    if (p === '/auth/google') {
      if (!G.clientId) return redirect(res, '/login?error=Google+sign-in+is+not+set+up');
      const state = randomToken();
      const next = safeNext(url.searchParams.get('next'));
      return redirect(res, google.authUrl({ ...G, state }), { 'Set-Cookie': cookie('zb_state', `${state}|${next}`, { maxAge: 600, secure: SECURE }) });
    }
    if (p === '/auth/google/callback') {
      const [state, next] = (cookies(req).zb_state || '').split('|');
      if (!state || state !== url.searchParams.get('state')) return redirect(res, '/login?error=Sign-in+expired.+Try+again');
      try {
        const profile = await google.profile({ ...G, code: url.searchParams.get('code') || '' });
        const u = accounts.upsert(profile);
        return redirect(res, safeNext(next), { 'Set-Cookie': [accounts.sessionCookie(u.id, SECURE), cookie('zb_state', '', { maxAge: 0 })] });
      } catch (e) { return redirect(res, '/login?error=' + encodeURIComponent(e.message)); }
    }
    if (p === '/auth/dev' && req.method === 'POST') {
      if (!DEV_LOGIN || !csrfOk(req)) return json(res, 403, { error: 'Not available' });
      const { email } = await body(req);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return json(res, 400, { error: 'Enter an email address' });
      const u = accounts.upsert({ email, name: email.split('@')[0] });
      return json(res, 200, { ok: true }, { 'Set-Cookie': accounts.sessionCookie(u.id, SECURE) });
    }
    if (p === '/auth/password' && req.method === 'POST') {
      if (!SITE_PASSWORD || !csrfOk(req)) return json(res, 403, { error: 'Not available' });
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (tooMany(ip)) return json(res, 429, { error: 'Too many tries. Wait ten minutes.' });
      const { password } = await body(req);
      const given = String(password || '').trim();
      const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(SITE_PASSWORD).digest();
      if (!crypto.timingSafeEqual(a, b)) {
        // the lengths only, never the passwords: enough to tell a typo from a wrong setting
        console.warn(`password sign-in refused: ${given.length} characters given, ${SITE_PASSWORD.length} expected`);
        return json(res, 401, { error: 'Wrong password' });
      }
      const u = accounts.upsert({ email: ADMIN || 'owner@zoneboard.local', name: 'Owner' });
      return json(res, 200, { ok: true }, { 'Set-Cookie': accounts.sessionCookie(u.id, SECURE) });
    }
    if (p === '/auth/logout' && req.method === 'POST') {
      if (!csrfOk(req)) return json(res, 403, { error: 'Refresh the page and try again' });
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('zb_s', '', { maxAge: 0, secure: SECURE }) });
    }

    /* member area */
    if (p === '/app' || p === '/checkout') {
      if (!user) return redirect(res, '/login?next=' + p);
      if (p === '/checkout' && OPEN_ACCESS) return redirect(res, '/app');
      return page(res, req, p === '/app' ? 'app.html' : 'site/checkout.html', { LOCKED: member(user) ? '' : '1', ADMIN: isAdmin(user) ? '1' : '', PER_DAY: PLANS[1].perDay });
    }
    if (p === '/api/me') {
      return json(res, 200, { user: meOf(user), plans: PLANS, razorpay: pay.ready ? { keyId: pay.keyId } : null, testPayments: !pay.ready && DEV_LOGIN, site: SITE });
    }
    if (p === '/api/board') {
      const real = member(user);
      return json(res, 200, { board: real ? board : sampleBoard(), sample: !real, ...statusFor(user) });
    }
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify(statusFor(user))}\n\n`);
      const c = { res, member: member(user) };
      clients.add(c);
      const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
      req.on('close', () => { clearInterval(ping); clients.delete(c); });
      return;
    }

    /* payments */
    if (p.startsWith('/api/checkout') && req.method === 'POST' && OPEN_ACCESS) return json(res, 403, { error: 'Not available' });
    if (p.startsWith('/api/checkout') && req.method === 'POST') {
      if (!user) return json(res, 401, { error: 'Please sign in' });
      if (!csrfOk(req)) return json(res, 403, { error: 'Refresh the page and try again' });
      const b = await body(req);
      if (p === '/api/checkout') {
        const plan = PLANS.find((x) => x.id === b.plan);
        if (!plan) return json(res, 400, { error: 'Pick a plan' });
        if (!pay.ready) return json(res, 503, { error: 'Payments are not set up yet' });
        const o = await pay.createOrder({ amount: plan.price * 100, receipt: `${user.id}-${Date.now()}`.slice(0, 40), notes: { user: user.id, plan: plan.id } });
        orders[o.id] = { userId: user.id, plan: plan.id, amount: o.amount, at: Date.now() }; saveOrders();
        return json(res, 200, { orderId: o.id, amount: o.amount, keyId: pay.keyId, name: SITE, email: user.email, plan: plan.name });
      }
      if (p === '/api/checkout/verify') {
        const o = orders[b.orderId];
        if (!o || o.userId !== user.id) return json(res, 400, { error: 'This payment does not match your order' });
        if (!pay.verify(b)) return json(res, 400, { error: 'Payment could not be verified. If money left your account, contact support with the payment ID.' });
        const plan = PLANS.find((x) => x.id === o.plan);
        const u = accounts.grant(user.id, plan.days, { orderId: b.orderId, paymentId: b.paymentId, plan: plan.id, amount: o.amount });
        delete orders[b.orderId]; saveOrders();
        return json(res, 200, { ok: true, paidUntil: u.paidUntil });
      }
      if (p === '/api/checkout/test') {
        if (pay.ready || !DEV_LOGIN) return json(res, 403, { error: 'Not available' });
        const plan = PLANS.find((x) => x.id === b.plan) || PLANS[0];
        const u = accounts.grant(user.id, plan.days, { orderId: 'test', paymentId: 'test-' + Date.now(), plan: plan.id, amount: 0 });
        return json(res, 200, { ok: true, paidUntil: u.paidUntil, test: true });
      }
    }

    /* the operator's daily Zerodha sign-in: admin only */
    if (p === '/admin/kite') {
      if (!isAdmin(user)) return redirect(res, '/login?next=/app');
      if (!kite.apiKey) { res.writeHead(500).end('Set KITE_API_KEY and KITE_API_SECRET first.'); return; }
      return redirect(res, kite.loginUrl());
    }
    if (p === '/callback') {
      if (!isAdmin(user)) return redirect(res, '/login?next=/app');
      try {
        const s = await kite.createSession(url.searchParams.get('request_token') || '');
        fs.writeFileSync(tokenFile(), JSON.stringify({ access_token: s.access_token }), { mode: 0o600 });
        setStatus('ready', 'Signed in'); loop();
        return redirect(res, '/app');
      } catch (e) { res.writeHead(400).end('Zerodha sign-in failed: ' + e.message); return; }
    }

    /* static files */
    if (p.startsWith('/static/')) {
      const file = path.join(ROOT, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (file.startsWith(path.join(ROOT, 'public', 'static')) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    page(res, req, 'site/404.html', {}, 404);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong' });
  }
}).listen(PORT, () => console.log(`${SITE} on ${BASE} (board: ${status}; Google ${G.clientId ? 'on' : 'off'}; password ${SITE_PASSWORD ? 'on' : 'off'}; ${OPEN_ACCESS ? 'open access' : 'Razorpay ' + (pay.ready ? 'on' : 'off')}${DEV_LOGIN ? '; DEV LOGIN ON' : ''})`));
