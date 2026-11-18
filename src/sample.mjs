// The board a visitor without a plan sees: real stock names laid out exactly as
// members see them, but every figure made up here. Nothing from the live board
// reaches it, so taking the blur off in the browser reveals nothing real.

const NAMES = ['SBIN', 'AXISBANK', 'TITAN', 'HDFCBANK', 'ICICIBANK', 'TATASTEEL', 'INFY', 'WIPRO', 'HCLTECH', 'RELIANCE',
  'LT', 'MARUTI', 'BHARTIARTL', 'ITC', 'ONGC', 'NTPC', 'COALINDIA', 'TCS', 'SUNPHARMA', 'CIPLA', 'DLF', 'GAIL', 'BEL', 'HAL',
  'TRENT', 'POLYCAB', 'VEDL', 'JSWSTEEL', 'HINDALCO', 'BPCL', 'IOC', 'PNB', 'CANBK', 'BANKBARODA', 'TECHM', 'LUPIN'];

function rng(seed) { // mulberry32: the same sample all day, a new one tomorrow
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function sampleBoard(day = new Date().toISOString().slice(0, 10)) {
  const r = rng([...day].reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
  const names = [...NAMES].sort(() => r() - 0.5);
  const row = (name, dir, rank) => {
    const ltp = Math.round((200 + r() * 2800) * 20) / 20;
    const chg = dir * (0.6 + r() * 3.4);
    const score = Math.round(90 - rank * 4 - r() * 5);
    const buildup = dir > 0 ? (r() > 0.3 ? 'long_buildup' : 'short_covering') : (r() > 0.3 ? 'short_buildup' : 'long_unwinding');
    const step = ltp * 0.004;
    const obLo = dir > 0 ? ltp - step * 3 : ltp + step * 2, obHi = obLo + step * 0.6;
    const candles = [];
    let p = ltp / (1 + chg / 100);
    for (let i = 0; i < 60; i++) {
      const o = p, c = o * (1 + (dir * 0.0009 + (r() - 0.5) * 0.004));
      candles.push([`${day}T${String(9 + Math.floor((15 + i * 5) / 60)).padStart(2, '0')}:${String((15 + i * 5) % 60).padStart(2, '0')}:00+05:30`,
        o, Math.max(o, c) * (1 + r() * 0.0015), Math.min(o, c) * (1 - r() * 0.0015), c]);
      p = c;
    }
    candles[candles.length - 1][4] = ltp;
    return {
      name, ltp, dir, score, chgPct: Math.round(chg * 100) / 100, buildup, oiChgPct: Math.round((r() * 6 - (buildup.includes('buildup') ? -1 : 5)) * 100) / 100,
      zones: { orderBlock: { lo: round(obLo), hi: round(obHi), t: candles[30][0] }, support: round(dir > 0 ? obLo - step : ltp - step * 2),
        resistance: round(dir > 0 ? ltp + step * 2 : obHi + step), liquidity: round(dir > 0 ? obLo - step * 1.6 : obHi + step * 1.6) },
      candles, sample: true,
    };
  };
  const bull = names.slice(0, 10).map((n, i) => row(n, 1, i));
  const bear = names.slice(10, 20).map((n, i) => row(n, -1, i));
  // a market's worth of dots for the X-ray; the counts are taken from these same dots so they add up
  const all = Array.from({ length: 218 }, (_, i) => {
    const chgPct = Math.round((r() * 7 - 3.2) * 100) / 100;
    return { name: names[i % names.length], chgPct, dir: chgPct >= 0 ? 1 : -1, score: Math.abs(chgPct) > 0.6 && r() > 0.3 ? 60 : 0 };
  });
  const counts = {
    bullish: all.filter((x) => x.dir > 0 && x.score > 0).length,
    bearish: all.filter((x) => x.dir < 0 && x.score > 0).length,
    choppy: all.filter((x) => x.score === 0).length,
  };
  return { asOf: null, sample: true, bull, bear, all, counts };
}

function round(v) { return Math.round(v * 100) / 100; }
