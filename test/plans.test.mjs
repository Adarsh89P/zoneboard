import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePlan, advance, finish, resultR, pickOption, tradingDaysBetween, firstPlan } from '../src/plans.mjs';

const at = (hhmm, o, h, l, c, day = '2026-11-18') => ({ t: `${day}T${hhmm}:00+05:30`, o, h, l, c });

/** Range, pullback with a down candle (the order block 99.8–100.5), impulse up through 101.5. */
function setup() {
  return [
    at('09:15', 100, 100.6, 99.6, 100.2), at('09:20', 100.2, 100.8, 99.9, 100.5), at('09:25', 100.5, 101.5, 100.3, 101.2),
    at('09:30', 101.2, 101.3, 100.4, 100.6), at('09:35', 100.6, 100.9, 100.1, 100.3), at('09:40', 100.3, 100.5, 99.8, 99.9),
    at('09:45', 99.9, 101.2, 99.9, 101.1), at('09:50', 101.1, 102.6, 101.0, 102.5), at('09:55', 102.5, 102.9, 102.1, 102.7),
    at('10:00', 102.7, 103.1, 102.4, 103.0), at('10:05', 103.0, 103.2, 102.6, 102.9),
  ];
}

test('a bullish plan waits at the top of the order block with the stop under it and 2R target', () => {
  const p = makePlan({ name: 'X', dir: 1, ltp: 102.9 }, setup());
  assert.equal(p.side, 'CALL');
  assert.equal(p.entry, 100.5);
  assert.ok(p.stop < 99.8);
  assert.ok(Math.abs((p.target - p.entry) - 2 * (p.entry - p.stop)) <= 0.011, 'target is 2R (to the paisa)');
  assert.equal(p.status, 'waiting');
});

test('no plans before 09:20 or after 14:30', () => {
  const early = setup().map((c) => ({ ...c, t: c.t.replace('T09:', 'T08:').replace('T10:', 'T09:0') }));
  assert.equal(makePlan({ name: 'X', dir: 1, ltp: 102.9 }, early.slice(0, 3)), null);
  const late = setup().map((c, i) => ({ ...c, t: `2026-11-18T14:${String(31 + i).padStart(2, '0')}:00+05:30` }));
  assert.equal(makePlan({ name: 'X', dir: 1, ltp: 102.9 }, late), null);
});

test('waiting → active → target, and the stop wins a candle that touches both', () => {
  const p = makePlan({ name: 'X', dir: 1, ltp: 102.9 }, setup());
  advance(p, [at('10:10', 102.9, 103, 100.4, 100.6)]);           // dips into the zone: entered
  assert.equal(p.status, 'active');
  advance(p, [at('10:15', 100.6, p.target + 1, 100.5, p.target)]); // reaches target
  assert.equal(p.status, 'target');
  assert.equal(resultR(p), 2);

  const q = makePlan({ name: 'Y', dir: 1, ltp: 102.9 }, setup());
  advance(q, [at('10:10', 102.9, 103, 100.4, 100.6), at('10:15', 100.6, q.target + 1, q.stop - 0.1, 100)]);
  assert.equal(q.status, 'stop');
  assert.equal(resultR(q), -1);
});

test('a plan that never triggers expires; one still open at the close is closed at the last price', () => {
  const p = makePlan({ name: 'X', dir: 1, ltp: 102.9 }, setup());
  finish(advance(p, [at('15:20', 103, 103.5, 102.8, 103.2)]), at('15:25', 103, 103, 103, 103.1));
  assert.equal(p.status, 'expired');
  assert.equal(resultR(p), null);

  const q = makePlan({ name: 'Y', dir: 1, ltp: 102.9 }, setup());
  advance(q, [at('10:10', 102.9, 103, 100.4, 100.6), at('15:15', 100.6, 101, 100.6, 101)]);
  assert.equal(q.status, 'closed');
  assert.ok(resultR(q) > 0 && resultR(q) < 2);
});

test('option: at-the-money strike, skipping an expiry two trading days or less away', () => {
  const leg = (s, k) => ({ symbol: `X26${s}${k}CE`, strike: k, lot: 100 });
  const chain = { '2026-11-23': { CE: [leg('NOV', 100), leg('NOV', 105)], PE: [] }, '2026-12-29': { CE: [leg('DEC', 100), leg('DEC', 105)], PE: [] } };
  assert.equal(tradingDaysBetween('2026-11-18', '2026-11-23'), 3);
  assert.equal(pickOption(chain, 103.4, 'CALL', '2026-11-18').symbol, 'X26NOV105CE');
  assert.equal(pickOption(chain, 101, 'CALL', '2026-11-20').symbol, 'X26DEC100CE'); // Fri → Mon expiry is 1 day away
});

test('firstPlan replays the board: the first candle with a score and a setup', () => {
  const prev = [at('15:25', 98, 98.5, 97.8, 98.2, '2026-11-17')];
  const p = firstPlan('X', prev, setup());
  assert.ok(p);
  assert.equal(p.dir, 1);
  assert.equal(p.entry, 100.5);
});

test('open access with a password: no paywall, no pricing, password sign-in', async () => {
  const PORT = 30000 + Math.floor(Math.random() * 20000), BASE = `http://127.0.0.1:${PORT}`;
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-'));
  const srv = spawn(process.execPath, ['server.mjs', '--snapshot', 'data/board-live.json'], {
    cwd: path.join(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, OPEN_ACCESS: '1', SITE_PASSWORD: 'correct horse', SESSION_SECRET: 'y'.repeat(40), ADMIN_EMAIL: 'owner@example.com' }, stdio: 'pipe',
  });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.match(await (await fetch(BASE + '/')).text(), /data-paid=""/);
    const jar = {};
    const go = async (p, init = {}) => {
      const r = await fetch(BASE + p, { redirect: 'manual', ...init, headers: { ...(init.headers || {}), Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
      for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
      return r;
    };
    await go('/login');
    const pw = (password) => go('/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF': decodeURIComponent(jar.zb_csrf) }, body: JSON.stringify({ password }) });
    assert.equal((await pw('wrong')).status, 401);
    assert.equal((await pw('correct horse')).status, 200);
    const me = await (await go('/api/me')).json();
    assert.equal(me.user.member, true);
    assert.equal(me.user.admin, true);
    const b = await (await go('/api/board')).json();
    assert.equal(b.sample, false);
    assert.ok(b.board.plans.length > 0);
    assert.equal((await go('/checkout')).headers.get('location'), '/app');
  } finally { srv.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); }
});
