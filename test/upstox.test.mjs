import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const istDay = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const TODAY = istDay(Date.now()), EXP = Date.parse(TODAY + 'T15:30:00+05:30') + 20 * 864e5;
const NAMES = Array.from({ length: 24 }, (_, i) => 'S' + i);
const rows = [
  ...NAMES.flatMap((n, i) => [
    { segment: 'NSE_EQ', instrument_type: 'EQ', trading_symbol: n, name: n + ' LIMITED', instrument_key: 'NSE_EQ|EQ' + i, lot_size: 1 },
    { segment: 'NSE_FO', instrument_type: 'FUT', underlying_type: 'EQUITY', underlying_symbol: n, trading_symbol: `${n} FUT`, instrument_key: 'NSE_FO|F' + i, lot_size: 100, expiry: EXP },
    { segment: 'NSE_FO', instrument_type: 'CE', underlying_type: 'EQUITY', underlying_symbol: n, trading_symbol: `${n} 100 CE`, instrument_key: 'NSE_FO|C' + i, lot_size: 100, expiry: EXP, strike_price: 100 },
  ]),
  { segment: 'NSE_FO', instrument_type: 'FUT', underlying_type: 'INDEX', underlying_symbol: 'NIFTY', trading_symbol: 'NIFTY FUT', instrument_key: 'NSE_FO|NF', lot_size: 75, expiry: EXP },
];
const seen = [];

/** A fake Upstox: instruments file, token exchange, quotes and candles. */
function fakeUpstox() {
  return http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x'); seen.push(u.pathname);
    if (u.pathname === '/NSE.json.gz') return r.end(zlib.gzipSync(JSON.stringify(rows)));
    r.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/v2/login/authorization/token') {
      let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => {
        const f = new URLSearchParams(b);
        if (f.get('code') !== 'good' || f.get('client_secret') !== 'sec') { r.statusCode = 400; return r.end(JSON.stringify({ status: 'error', errors: [{ errorCode: 'UDAPI100057', message: 'Invalid Auth code' }] })); }
        r.end(JSON.stringify({ access_token: 'tok', user_name: 'x' }));
      });
      return;
    }
    if (q.headers.authorization !== 'Bearer tok') { r.statusCode = 401; return r.end(JSON.stringify({ status: 'error', errors: [{ errorCode: 'UDAPI100050', message: 'Invalid token used to access API' }] })); }
    if (u.pathname === '/v2/market-quote/quotes') {
      const data = {};
      for (const k of u.searchParams.get('instrument_key').split(',')) {
        const i = +(k.match(/\d+$/)?.[0] ?? 0), ch = (i - 12) / 4, prev = 100;
        data[k.replace('|', ':')] = { instrument_token: k, last_price: prev + ch, net_change: ch, volume: 1e5, oi: k.startsWith('NSE_FO') ? 1e6 : 0,
          ohlc: { open: prev, high: prev + Math.max(ch, 0) + 0.2, low: prev + Math.min(ch, 0) - 0.2, close: prev + ch } };
      }
      return r.end(JSON.stringify({ status: 'success', data }));
    }
    if (u.pathname.startsWith('/v3/historical-candle/')) {
      // newest first, as Upstox sends them
      const intraday = u.pathname.includes('/intraday/');
      const c = intraday ? [[`${TODAY}T09:20:00+05:30`, 100, 101, 99.5, 100.5, 10, 5], [`${TODAY}T09:15:00+05:30`, 100, 100.4, 99.8, 100, 10, 5]] : [['2026-11-20T15:25:00+05:30', 99, 100, 98.5, 100, 10, 5], ['2026-11-20T15:20:00+05:30', 99, 99.5, 98.8, 99, 10, 5]];
      return r.end(JSON.stringify({ status: 'success', data: { candles: c } }));
    }
    r.statusCode = 404; r.end('{}');
  });
}

test('Upstox: sign in with the code, then a ranked board from Upstox quotes', async () => {
  const fake = fakeUpstox(); await new Promise((ok) => fake.listen(0, ok));
  const UP = `http://127.0.0.1:${fake.address().port}`;
  const PORT = 30000 + Math.floor(Math.random() * 20000), BASE = `http://127.0.0.1:${PORT}`;
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-up-'));
  const srv = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, PORT: String(PORT), BASE_URL: BASE, DATA_DIR,
    UPSTOX_API_KEY: 'key', UPSTOX_API_SECRET: 'sec', UPSTOX_API_URL: UP, UPSTOX_INSTRUMENTS_URL: UP + '/NSE.json.gz',
    OPEN_ACCESS: '1', SITE_PASSWORD: 'pw', ADMIN_EMAIL: 'owner@zoneboard.local', SESSION_SECRET: 'u'.repeat(40) } });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/'); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const jar = {};
    const go = async (p, init = {}) => {
      const r = await fetch(BASE + p, { redirect: 'manual', ...init, headers: { ...(init.headers || {}), Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
      for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
      return r;
    };
    await go('/login');
    assert.equal((await go('/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF': decodeURIComponent(jar.zb_csrf) }, body: JSON.stringify({ password: 'pw' }) })).status, 200);
    assert.match(await (await go('/app')).text(), /Connect Upstox/);
    const login = new URL((await go('/admin/kite')).headers.get('location'));
    assert.equal(login.origin + login.pathname, 'https://api.upstox.com/v2/login/authorization/dialog');
    assert.equal(login.searchParams.get('client_id'), 'key');
    assert.equal(login.searchParams.get('redirect_uri'), BASE + '/callback');
    assert.equal((await go('/callback?code=bad')).status, 400);
    assert.equal((await go('/callback?code=good')).headers.get('location'), '/app');
    let b;
    for (let i = 0; i < 80; i++) { b = await (await go('/api/board')).json(); if (b.board?.bull?.length) break; await new Promise((ok) => setTimeout(ok, 100)); }
    assert.equal(b.sample, false);
    assert.deepEqual(b.board.bull.slice(0, 3).map((r) => r.name), ['S23', 'S22', 'S21']);
    assert.ok(b.board.bear.some((r) => r.name === 'S0'));
    const top = b.board.bull[0];
    assert.equal(top.chgPct, 2.75, 'change measured from yesterday\'s close (last price − net change)');
    assert.ok(seen.includes('/v2/market-quote/quotes'));
  } finally { srv.kill(); fake.close(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); }
});

test('Upstox candles: long ranges walk back a month at a time, finished days are cached, today comes from intraday', async () => {
  const { Upstox } = await import('../src/upstox.mjs');
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url).replace(/^.*\/v3\/historical-candle\//, ''));
    const today = String(url).includes('/intraday/');
    return new Response(JSON.stringify({ status: 'success', data: { candles: today ? [[`${TODAY}T09:15:00+05:30`, 1, 2, 0.5, 1.5, 9, 0]] : [['2026-09-01T09:15:00+05:30', 1, 2, 0.5, 1.5, 9, 0]] } }));
  };
  try {
    const u = new Upstox('k', 's', 'http://x/callback', 'tok');
    const from = new Date(Date.now() - 87 * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
    const c = await u.historical('NSE_EQ|X', '5minute', from, TODAY + ' 23:59:59');
    const ranges = calls.filter((x) => !x.startsWith('intraday')).map((x) => x.split('/').slice(-2));
    assert.equal(ranges.length, 4, '87 days in 28-day steps');
    assert.equal(ranges.at(-1)[1], from, 'the last step starts at from');
    for (let i = 1; i < ranges.length; i++) assert.equal(new Date(Date.parse(ranges[i][0]) + 864e5).toISOString().slice(0, 10), ranges[i - 1][1], 'steps touch without gaps');
    assert.ok(ranges.every(([to, fr]) => (Date.parse(to) - Date.parse(fr)) / 864e5 <= 27));
    assert.equal(c.at(-1).t.slice(0, 10), TODAY, 'today from the intraday call, oldest first');
    const before = calls.length;
    await u.historical('NSE_EQ|X', '5minute', from, TODAY);
    assert.equal(calls.length, before + 1, 'second time: only today is fetched');
  } finally { globalThis.fetch = real; }
});
