// The website end to end: a real server on a spare port, in snapshot mode with test sign-in.
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Razorpay } from '../src/payments.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-'));
let server;

test.before(async () => {
  server = spawn(process.execPath, ['server.mjs', '--snapshot', 'data/board-2026-11-17.json'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR, DEV_LOGIN: '1', SESSION_SECRET: 'x'.repeat(40), ADMIN_EMAIL: 'owner@example.com', HTTPS_PROXY: '', https_proxy: '' },
    stdio: 'pipe',
  });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
test.after(() => { server?.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

/** A tiny cookie jar: what a browser would send back. */
function client() {
  const jar = {};
  const go = async (p, init = {}) => {
    const r = await fetch(BASE + p, { redirect: 'manual', ...init, headers: { ...(init.headers || {}), Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return r;
  };
  const post = (p, body) => go(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF': decodeURIComponent(jar.zb_csrf || '') }, body: JSON.stringify(body) });
  return { go, post, jar };
}

test('public pages render with the site name and no template slots left', async () => {
  for (const p of ['/', '/login', '/terms', '/privacy', '/refunds', '/disclaimer']) {
    const r = await fetch(BASE + p);
    const html = await r.text();
    assert.equal(r.status, 200, p);
    assert.match(html, /ZoneBoard/, p);
    assert.doesNotMatch(html, /\{\{\w+\}\}/, p);
  }
  assert.equal((await fetch(BASE + '/nope')).status, 404);
});

test('the board needs sign-in; without a plan it is a made-up sample', async () => {
  const c = client();
  const r = await c.go('/app');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/login\?next=\/app/);

  const anon = await (await fetch(BASE + '/api/board')).json();
  assert.equal(anon.sample, true);
  assert.ok(anon.board.bull.every((x) => x.sample));
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/board-2026-11-17.json'), 'utf8'));
  assert.notDeepEqual(anon.board.bull.map((x) => x.ltp), real.bull.map((x) => x.ltp)); // nothing real leaks
});

test('sign in, buy a plan (test mode), then the real board', async () => {
  const c = client();
  await c.go('/login'); // sets the CSRF cookie
  assert.equal((await c.go('/auth/dev', { method: 'POST', body: '{"email":"a@b.co"}', headers: { 'Content-Type': 'application/json' } })).status, 403, 'POST without CSRF header is refused');
  assert.equal((await c.post('/auth/dev', { email: 'trader@example.com' })).status, 200);

  let me = await (await c.go('/api/me')).json();
  assert.equal(me.user.email, 'trader@example.com');
  assert.equal(me.user.member, false);
  assert.equal((await (await c.go('/api/board')).json()).sample, true);

  const app = await (await c.go('/app')).text();
  assert.match(app, /data-locked="1"/);

  assert.equal((await c.post('/api/checkout/test', { plan: 'monthly' })).status, 200);
  me = await (await c.go('/api/me')).json();
  assert.equal(me.user.member, true);
  assert.ok(me.user.paidUntil > Date.now() + 29 * 864e5);

  const b = await (await c.go('/api/board')).json();
  assert.equal(b.sample, false);
  assert.equal(b.board.bull[0].name, 'MAHABANK');
  assert.match(await (await c.go('/app')).text(), /data-locked=""/);

  assert.equal((await c.post('/auth/logout', {})).status, 200);
  assert.equal((await (await c.go('/api/me')).json()).user, null);
});

test('a forged session cookie is ignored', async () => {
  const r = await fetch(BASE + '/api/me', { headers: { Cookie: 'zb_s=u_123.9999999999999.forged' } });
  assert.equal((await r.json()).user, null);
});

test('only the admin can start the Zerodha sign-in', async () => {
  const c = client();
  await c.go('/login'); await c.post('/auth/dev', { email: 'someone@example.com' });
  const r = await c.go('/admin/kite');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/login/);
});

test('Razorpay signature check', () => {
  const rp = new Razorpay('rzp_test_x', 'secret123');
  const signature = crypto.createHmac('sha256', 'secret123').update('order_1|pay_1').digest('hex');
  assert.equal(rp.verify({ orderId: 'order_1', paymentId: 'pay_1', signature }), true);
  assert.equal(rp.verify({ orderId: 'order_1', paymentId: 'pay_2', signature }), false);
  assert.equal(rp.verify({ orderId: 'order_1', paymentId: 'pay_1', signature: 'nope' }), false);
});
