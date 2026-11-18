import test from 'node:test';
import assert from 'node:assert/strict';
import { oiBuildup, oiDrift, scoreStock, rankBoard, dailyStats, aggregate, findOrderBlock, zones } from '../src/engine.mjs';
import { Kite } from '../src/kite.mjs';

test('OI build-up follows price and OI together', () => {
  assert.equal(oiBuildup(1, 2), 'long_buildup');
  assert.equal(oiBuildup(1, -2), 'short_covering');
  assert.equal(oiBuildup(-1, 2), 'short_buildup');
  assert.equal(oiBuildup(-1, -2), 'long_unwinding');
  assert.equal(oiBuildup(-1, null), 'unknown');
});

test('a clean trend day scores; a stock that gave its move back is choppy', () => {
  const trend = scoreStock({ ltp: 104, prevClose: 100, open: 100.2, high: 104.2, low: 100, atrPct: 2, oi: 110, prevOi: 100 });
  assert.equal(trend.dir, 1);
  assert.ok(trend.score > 70, `score ${trend.score}`);
  assert.equal(trend.buildup, 'long_buildup');
  const faded = scoreStock({ ltp: 100.8, prevClose: 100, open: 101, high: 104, low: 100.5 });
  assert.equal(faded.score, 0);
  assert.ok(faded.choppy);
});

test('a market-wide OI drain (rollover) is taken out before reading build-up', () => {
  const pairs = Array.from({ length: 40 }, (_, i) => ({ oi: 95 + (i % 3), prevOi: 100 })); // everyone about -4%
  const drift = oiDrift(pairs);
  assert.ok(drift < -3 && drift > -6, `drift ${drift}`);
  const s = scoreStock({ ltp: 98, prevClose: 100, open: 100, high: 100.1, low: 97.9, oi: 99, prevOi: 100, oiDrift: drift });
  assert.equal(s.oiRawPct, -1);
  assert.equal(s.buildup, 'short_buildup'); // fell 1% while the market drained ~4%: fresh shorts
});

test('boards keep sides apart and sort strongest first', () => {
  const b = rankBoard([
    { name: 'A', dir: 1, score: 60, chgPct: 1 }, { name: 'B', dir: 1, score: 80, chgPct: 2 },
    { name: 'C', dir: -1, score: 70, chgPct: -2 }, { name: 'D', dir: 1, score: 0, chgPct: 0.1 },
  ]);
  assert.deepEqual(b.bull.map((r) => r.name), ['B', 'A']);
  assert.deepEqual(b.bear.map((r) => r.name), ['C']);
  assert.deepEqual(b.counts, { bullish: 2, bearish: 1, choppy: 1 });
});

test('ATR and average volume from daily candles', () => {
  const days = Array.from({ length: 20 }, (_, i) => ['d' + i, 100, 102, 98, 100, 1000]);
  const s = dailyStats(days);
  assert.equal(Math.round(s.atrPct * 100) / 100, 4);
  assert.equal(s.avgVolume, 1000);
});

test('1-minute candles roll up into 5-minute buckets', () => {
  const ones = Array.from({ length: 10 }, (_, i) => ({ t: `2026-11-17T09:${String(15 + i).padStart(2, '0')}:00+05:30`, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 10 }));
  const fives = aggregate(ones, 5);
  assert.equal(fives.length, 2);
  assert.deepEqual([fives[0].o, fives[0].h, fives[0].l, fives[0].c, fives[0].v], [100, 105, 99, 104.5, 50]);
});

/* a range, a pullback with a down candle, then an impulse up through the range high */
function bullishSetup() {
  const c = [];
  const push = (o, h, l, cl) => c.push({ t: `2026-11-17T${String(9 + Math.floor((15 + c.length * 5) / 60)).padStart(2, '0')}:${String((15 + c.length * 5) % 60).padStart(2, '0')}:00+05:30`, o, h, l, c: cl });
  push(100, 100.6, 99.6, 100.2); push(100.2, 100.8, 99.9, 100.5); push(100.5, 101.5, 100.3, 101.2);   // swing high 101.5 at i=2
  push(101.2, 101.3, 100.4, 100.6); push(100.6, 100.9, 100.1, 100.3); push(100.3, 100.5, 99.8, 99.9); // pullback, last down candle i=5
  push(99.9, 101.2, 99.9, 101.1); push(101.1, 102.6, 101.0, 102.5);                                    // impulse breaks 101.5
  push(102.5, 102.9, 102.1, 102.7); push(102.7, 103.1, 102.4, 103.0); push(103.0, 103.2, 102.6, 102.9);
  return c;
}

test('order block: last down candle before the break of structure', () => {
  const c = bullishSetup();
  const ob = findOrderBlock(c, 1);
  assert.ok(ob, 'found');
  assert.equal(ob.i, 5);
  assert.deepEqual([ob.lo, ob.hi, ob.broke], [99.8, 100.5, 101.5]);
  // a close back under the zone voids it
  const broken = [...c, { t: '2026-11-17T10:10:00+05:30', o: 102, h: 102, l: 99, c: 99.5 }];
  assert.equal(findOrderBlock(broken, 1), null);
});

test('levels sit on the right side of price', () => {
  const z = zones(bullishSetup(), 1, 102.9);
  assert.ok(z.orderBlock.hi < 102.9);
  assert.ok(z.support == null || z.support < z.orderBlock.lo);
  assert.ok(z.resistance == null || z.resistance > 102.9);
});

test('Kite client: login checksum, F&O universe and quotes', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    const json = (data) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
    if (u.endsWith('/session/token')) return json({ access_token: 'tok' });
    if (u.endsWith('/instruments/NFO')) return new Response(
      'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n' +
      '1,1,SBIN26NOVFUT,SBIN,0,2026-11-24,0,0.05,750,FUT,NFO-FUT,NFO\n' +
      '2,2,SBIN26DECFUT,SBIN,0,2026-12-29,0,0.05,750,FUT,NFO-FUT,NFO\n' +
      '3,3,NIFTY26NOVFUT,NIFTY,0,2026-11-24,0,0.05,75,FUT,NFO-FUT,NFO\n' +
      '4,4,SBIN26NOV1100CE,SBIN,0,2026-11-24,1100,0.05,750,CE,NFO-OPT,NFO\n');
    if (u.endsWith('/instruments/NSE')) return new Response(
      'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n' +
      '779521,3045,SBIN,STATE BANK OF INDIA,0,,0,0.05,1,EQ,NSE,NSE\n');
    if (u.includes('/quote?')) return json({ 'NSE:SBIN': { last_price: 1108.6 } });
    return new Response('{}', { status: 404 });
  };
  const k = new Kite('key', 'secret');
  await k.createSession('req');
  assert.equal(k.accessToken, 'tok');
  const sent = new URLSearchParams(String(calls[0].init.body));
  assert.equal(sent.get('checksum').length, 64);
  const uni = await k.fnoUniverse(new Date('2026-11-17T06:00:00Z'));
  assert.deepEqual(uni, [{ name: 'SBIN', fut: 'SBIN26NOVFUT', fut_token: 1, lot: 750, token: 779521, fut2: 'SBIN26DECFUT', fut2_token: 2 }]);
  const q = await k.quote(['NSE:SBIN']);
  assert.equal(q['NSE:SBIN'].last_price, 1108.6);
  assert.match(calls.at(-1).init.headers.Authorization, /^token key:tok$/);
});
