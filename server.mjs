// OB Scanner server.
//   Live:     KITE_API_KEY=… KITE_API_SECRET=… node server.mjs
//             then open http://localhost:8080 and sign in with Zerodha once a day.
//   Snapshot: node server.mjs --snapshot data/board-2026-11-17.json   (no Kite needed)
// The board is pushed to the page over Server-Sent Events every minute while
// the market is open (09:15–15:30 IST, Mon–Fri; exchange holidays are not known to it).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Kite } from './src/kite.mjs';
import { scoreStock, rankBoard, dailyStats, zones, oiDrift } from './src/engine.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DATA = path.join(ROOT, 'data');
const PORT = +(process.env.PORT || 8080);
const TOP = 20;          // rows per side on the board
const ZONED = 10;        // rows per side that get 5-minute candles and zones each minute
const args = process.argv.slice(2);
const snapshotFile = args.includes('--snapshot') ? args[args.indexOf('--snapshot') + 1] : null;

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

function push(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
function setStatus(s, n) { status = s; note = n; push('status', { status, note, market: market() }); }

/* ── daily preparation: ATR, average volume, yesterday's futures OI ───
 * About two calls per stock, paced to Kite's limit: a couple of minutes once
 * a day, cached so a restart the same day does not repeat it. */
let universe = null, daily = null;
async function prepare() {
  const file = path.join(DATA, `prep-${ymd()}.json`);
  try { ({ universe, daily } = JSON.parse(fs.readFileSync(file, 'utf8'))); return; } catch { }
  setStatus('preparing', 'Loading the F&O list');
  universe = await kite.fnoUniverse();
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
  fs.writeFileSync(file, JSON.stringify({ universe, daily }));
}

/* ── one scan ───────────────────────────────────────────────────────── */
async function scan() {
  const q = await kite.quote(universe.flatMap((u) => ['NSE:' + u.name, 'NFO:' + u.fut, ...(u.fut2 ? ['NFO:' + u.fut2] : [])]));
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
  for (const r of [...ranked.bull.slice(0, ZONED), ...ranked.bear.slice(0, ZONED)]) {
    try {
      const c = await kite.historical(r.token, '5minute', daysAgo(5), ymd() + ' 23:59:59');
      const days = [...new Set(c.map((x) => x.t.slice(0, 10)))].slice(-2);
      const recent = c.filter((x) => days.includes(x.t.slice(0, 10)));
      r.zones = zones(recent, r.dir, r.ltp);
      r.candles = recent.slice(-75).map((x) => [x.t, x.o, x.h, x.l, x.c]);
    } catch { /* the row stays on the board without its chart */ }
  }
  const strip = ({ token, parts, ...r }) => r;
  board = {
    asOf: new Date().toISOString(), market: market(), oiDrift: Math.round(drift * 100) / 100,
    bull: ranked.bull.map(strip), bear: ranked.bear.map(strip), counts: ranked.counts,
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
    push('status', { status, note, market: m });
  } catch (e) {
    if (e.status === 403) { kite.accessToken = ''; universe = null; setStatus('signed_out', 'Zerodha session ended. Sign in again'); }
    else setStatus('error', e.message);
  } finally { running = false; }
}
setInterval(loop, 60e3);
loop();

/* ── http ───────────────────────────────────────────────────────────── */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/login') {
    if (!kite.apiKey) { res.writeHead(500).end('Set KITE_API_KEY and KITE_API_SECRET first.'); return; }
    res.writeHead(302, { Location: kite.loginUrl() }).end(); return;
  }
  if (url.pathname === '/callback') {
    try {
      const s = await kite.createSession(url.searchParams.get('request_token') || '');
      fs.writeFileSync(tokenFile(), JSON.stringify({ access_token: s.access_token }));
      setStatus('ready', 'Signed in'); loop();
      res.writeHead(302, { Location: '/' }).end();
    } catch (e) { res.writeHead(400).end('Sign-in failed: ' + e.message); }
    return;
  }
  if (url.pathname === '/api/board') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ board, status, note, market: market() })); return;
  }
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: status\ndata: ${JSON.stringify({ status, note, market: market() })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  const file = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file)) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`OB Scanner on http://localhost:${PORT} (${status})`));
