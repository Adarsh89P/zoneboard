// Replays the trade-plan rules on past sessions, candle by candle, with only the
// information the board would have had at each moment.
//   node scripts/backtest.mjs --files data/candles data/candles-live      (saved 1-minute candle files)
//   KITE_API_KEY=… KITE_ACCESS_TOKEN=… node scripts/backtest.mjs --kite --days 60   (all F&O stocks from Kite)
// Per stock and session: from 09:20 the stock is scored as the scanner scores it (price only:
// past OI and volume averages are not replayed). The first moment it would sit on a board
// with a plan, the plan is made; it then runs to target, stop or the 15:15 close.
import fs from 'node:fs';
import path from 'node:path';
import { aggregate } from '../src/engine.mjs';
import { firstPlan, finish, resultR, minuteOf } from '../src/plans.mjs';
import { Kite } from '../src/kite.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BOARD_SCORE = 60;
/** The directories after --files, up to the next flag. */
const filesArg = () => { const out = []; for (let i = args.indexOf('--files') + 1; i < args.length && !args[i].startsWith('--'); i++) out.push(args[i]); return out; };

const sessions = (c) => [...new Set(c.map((x) => x.t.slice(0, 10)))];

/** One stock: every finished session that has a session before it. */
export function replayStock(name, oneMinute) {
  const c5 = aggregate(oneMinute, 5), days = sessions(c5), trades = [];
  for (let d = 1; d < days.length; d++) {
    const prev = c5.filter((x) => x.t.startsWith(days[d - 1])), today = c5.filter((x) => x.t.startsWith(days[d]));
    // only finished sessions: a day still trading would count open plans as nothing
    if (!prev.length || today.length < 10 || minuteOf(today.at(-1).t) < 15 * 60) continue;
    const plan = firstPlan(name, prev, today, {}, BOARD_SCORE);
    if (plan) { finish(plan, today.at(-1)); trades.push({ day: days[d], ...plan, r: resultR(plan) }); }
  }
  return trades;
}

export function summarise(trades) {
  const done = trades.filter((t) => t.r != null);
  const wins = done.filter((t) => t.r > 0);
  const sum = done.reduce((a, t) => a + t.r, 0);
  const by = (s) => trades.filter((t) => t.status === s).length;
  return {
    plans: trades.length, triggered: done.length, neverTriggered: by('waiting') + by('expired'),
    targets: by('target'), stops: by('stop'), closedAt1515: by('closed'),
    winRate: done.length ? Math.round((wins.length / done.length) * 1000) / 10 : null,
    avgR: done.length ? Math.round((sum / done.length) * 100) / 100 : null, totalR: Math.round(sum * 100) / 100,
  };
}

async function fromFiles(dirs) {
  const seen = new Map();
  for (const dir of dirs) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const c = (raw.data?.candles ?? raw.data ?? raw).map((x) => Array.isArray(x)
      ? { t: x[0], o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] } : { t: x.date, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume });
    const name = f.replace(/\.json$/, '');
    const prev = seen.get(name) || [];
    const merged = new Map([...prev, ...c].map((x) => [x.t, x]));
    seen.set(name, [...merged.values()].sort((a, b) => a.t.localeCompare(b.t)));
  }
  return seen;
}

async function fromKite(days) {
  const k = new Kite(process.env.KITE_API_KEY, '', process.env.KITE_ACCESS_TOKEN);
  const uni = await k.fnoUniverse(), out = new Map();
  const to = new Date(), from = new Date(Date.now() - days * 1.45 * 864e5);
  const ymd = (d) => d.toISOString().slice(0, 10);
  for (const [i, u] of uni.entries()) {
    process.stderr.write(`\r${i + 1}/${uni.length} ${u.name}        `);
    // Kite serves at most 60 days of 1-minute candles per call; 5-minute is enough here
    try { out.set(u.name, await k.historical(u.token, '5minute', ymd(from), ymd(to))); } catch { }
  }
  process.stderr.write('\n');
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = args.includes('--kite') ? await fromKite(+opt('--days', 60))
    : await fromFiles(filesArg());
  const trades = [...data].flatMap(([name, c]) => replayStock(name, c));
  const s = summarise(trades);
  const days = [...new Set(trades.map((t) => t.day))].length;
  console.log(`stocks ${data.size} · sessions with a plan ${days} · plans ${s.plans}`);
  console.log(JSON.stringify(s, null, 2));
  for (const t of trades) console.log(`${t.day} ${t.name.padEnd(11)} ${t.side.padEnd(4)} entry ${t.entry} stop ${t.stop} target ${t.target} (${t.createdAt.slice(11, 16)}) → ${t.status}${t.r != null ? ' ' + t.r + 'R' : ''}`);
  if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify({ summary: s, trades }, null, 2));
}
