// Builds a board from saved Kite data, for testing the engine and for an
// offline demo. Usage:
//   node scripts/snapshot.mjs <quotes.json> [--prev-oi prev-oi.json] [--daily daily-dir] [--candles candles-dir] [--out board.json]
// quotes.json: { "NSE:SBIN": {...}, "NFO:SBIN26NOVFUT": {...} } as Kite's /quote returns it.
// prev-oi.json: { "SBIN": 74081250 }. daily-dir / candles-dir: <NAME>.json holding Kite candles.
import fs from 'node:fs';
import path from 'node:path';
import { scoreStock, rankBoard, dailyStats, aggregate, zones, oiDrift } from '../src/engine.mjs';
import { firstPlan } from '../src/plans.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const tryRead = (p) => { try { return read(p); } catch { return undefined; } };

const quotes = read(args[0]);
const universe = read(path.join(path.dirname(new URL(import.meta.url).pathname), '../data/universe.json'));
const prevOi = opt('--prev-oi') ? read(opt('--prev-oi')) : {};
const dailyDir = opt('--daily'), candleDir = opt('--candles');

/** Kite candles arrive as [time, o, h, l, c, v, (oi)] or as {date, open, ...}. */
const asCandles = (raw) => (raw?.data?.candles ?? raw?.data ?? raw ?? []).map((c) => Array.isArray(c)
  ? { t: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] }
  : { t: c.date, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume });

const drift = oiDrift(universe.map((u) => ({ oi: quotes['NFO:' + u.fut]?.oi, prevOi: prevOi[u.name] })));
const rows = [];
for (const u of universe) {
  const q = quotes['NSE:' + u.name], f = quotes['NFO:' + u.fut];
  if (!q || !q.ohlc) continue;
  const daily = dailyDir && tryRead(path.join(dailyDir, u.name + '.json'));
  const stats = daily ? dailyStats(asCandles(daily).map((c) => [c.t, c.o, c.h, c.l, c.c, c.v])) : {};
  const s = scoreStock({
    ltp: q.last_price, prevClose: q.ohlc.close, open: q.ohlc.open, high: q.ohlc.high, low: q.ohlc.low,
    volume: q.volume, oi: f?.oi, prevOi: prevOi[u.name], oiDrift: drift, ...stats,
  });
  rows.push({ name: u.name, ltp: q.last_price, ...s });
}

const board = rankBoard(rows);
const plans = [];
if (candleDir) {
  for (const r of [...board.bull, ...board.bear]) {
    const raw = tryRead(path.join(candleDir, r.name + '.json'));
    if (!raw) continue;
    // the last two sessions, as the live server reads them
    const all = asCandles(raw), days = [...new Set(all.map((c) => c.t.slice(0, 10)))].slice(-2);
    const c5 = aggregate(all.filter((c) => days.includes(c.t.slice(0, 10))), 5);
    r.zones = zones(c5, r.dir, r.ltp);
    r.candles = c5.slice(-75).map((c) => [c.t, c.o, c.h, c.l, c.c]);
    // the plan the live board would have made today, run forward to the last candle
    const prev = c5.filter((c) => c.t.startsWith(days[0])), today = c5.filter((c) => c.t.startsWith(days[1]));
    const plan = days.length === 2 ? firstPlan(r.name, prev, today) : null;
    if (plan && plan.dir === r.dir) plans.push(plan);
  }
}

const backtest = tryRead(path.join(path.dirname(new URL(import.meta.url).pathname), '../data/backtest.json'));
const out = { asOf: Object.values(quotes)[0]?.timestamp, oiDrift: Math.round(drift * 100) / 100, plans, backtest: backtest && { ...backtest.summary, sessions: new Set(backtest.trades.map((t) => t.day)).size }, ...board, all: rows.map(({ name, chgPct, score, dir }) => ({ name, chgPct, score, dir })) };
const file = opt('--out');
if (file) fs.writeFileSync(file, JSON.stringify(out));
console.log(`as of ${out.asOf} · market OI drift ${out.oiDrift}% · bullish ${board.counts.bullish} · bearish ${board.counts.bearish} · choppy ${board.counts.choppy}`);
for (const [label, list] of [['BULLISH', board.bull], ['BEARISH', board.bear]]) {
  console.log('\n' + label);
  list.slice(0, 10).forEach((r, i) => console.log(
    `${String(i + 1).padStart(2)} ${r.name.padEnd(12)} ${(r.chgPct > 0 ? '+' : '') + r.chgPct.toFixed(2)}%  score ${r.score}  ` +
    `${r.buildup}${r.oiChgPct != null ? ' (' + r.oiChgPct + '% OI)' : ''}` +
    (r.zones?.orderBlock ? `  OB ${r.zones.orderBlock.lo}–${r.zones.orderBlock.hi}` : '')));
}
