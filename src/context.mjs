// News and events next to a plan: recent headlines for the stock, whether it is in the
// F&O ban, event words in the headlines (results, dividend, board meeting...), and an
// optional one-line AI summary of what the headlines say is behind the move.
//
// This is context for a person reading the board. None of it feeds the plan rules or the
// score, because headlines can't be replayed fairly in a backtest: so it can't be measured.

import Anthropic from '@anthropic-ai/sdk';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const cache = new Map();
/** fn() at most once per ttl for a key; a failed fetch is remembered for a minute, not retried every scan. */
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  let value;
  try { value = await fn(); cache.set(key, { value, until: Date.now() + ttl }); }
  catch { value = hit?.value ?? null; cache.set(key, { value, until: Date.now() + 60e3 }); }
  return value;
}

const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : ''; };

const iso = (s) => { const d = new Date(s); return isNaN(d) ? null : d.toISOString(); };

/** Google News RSS items: newest first, from the last `hours`, at most `max`. */
export function parseRss(xml, { hours = 48, max = 5, now = Date.now() } = {}) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, x]) => {
    const source = tag(x, 'source');
    let title = tag(x, 'title');
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    return { title, source, link: tag(x, 'link'), at: iso(tag(x, 'pubDate')) };
  }).filter((i) => i.title && i.at && now - Date.parse(i.at) < hours * 3600e3);
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, max);
}

/** Recent headlines for a stock, by its company name when known. Cached 15 minutes. */
export function news(name, company) {
  const q = company ? `"${company.replace(/\s+(LTD|LIMITED)\.?$/i, '')}"` : `${name} share`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&hl=en-IN&gl=IN&ceid=IN:en`;
  return cached('news:' + name, 15 * 60e3, async () => {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('news ' + r.status);
    return parseRss(await r.text());
  });
}

/** The day's market headlines (NIFTY / Sensex), for the morning mood. */
export const marketNews = () => cached('news:market', 15 * 60e3, async () => {
  const r = await fetch('https://news.google.com/rss/search?q=' + encodeURIComponent('Nifty Sensex stock market today when:1d') + '&hl=en-IN&gl=IN&ceid=IN:en',
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('news ' + r.status);
  return parseRss(await r.text(), { hours: 24, max: 8 });
});

/** NSE's F&O ban list: "1,SYMBOL" lines after a title line. */
export const parseBan = (csv) => new Set([...csv.matchAll(/^\s*\d+\s*,\s*([A-Z0-9&-]+)/gm)].map((m) => m[1]));
export const banList = () => cached('ban', 60 * 60e3, async () => {
  const r = await fetch('https://nsearchives.nseindia.com/content/fo/fo_secban.csv', { headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('ban ' + r.status);
  return [...parseBan(await r.text())];
});

const EVENTS = [
  ['results', /\b(results?|earnings|q[1-4]\s?(fy)?\d*|quarterly|profit|revenue|net loss)\b/i],
  ['dividend', /\bdividend\b/i], ['board meeting', /\bboard meeting\b/i],
  ['corporate action', /\b(bonus|split|buyback|rights issue|merger|demerger|acquisition|acquire|stake sale|block deal|bulk deal|ofs)\b/i],
  ['regulator', /\b(sebi|rbi|penalty|probe|raid|ban)\b/i],
  ['broker call', /\b(upgrade|downgrade|target price|rating)\b/i],
  ['order', /\b(order win|bags order|wins order|contract worth)\b/i],
];
/** Event words found in the headlines, once each. */
export const eventTags = (items = []) => EVENTS.filter(([, re]) => items.some((i) => re.test(i.title))).map(([k]) => k);

/* ── AI one-liners ──────────────────────────────────────────────────────
 * Only when ANTHROPIC_API_KEY is set. Short, cached per stock for 30 minutes, and told to
 * stick to the headlines it is given and never to say buy or sell. Server-side fallbacks
 * are on: if the main model is overloaded, Anthropic answers from a fallback model instead
 * of failing, so a line can occasionally come from a different model.
 * ──────────────────────────────────────────────────────────────────────── */
const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
let client = null;
export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY;
const SYSTEM = `You write one short line of context for a private Indian stock-market analytics board.
You get a stock (or the index), its move today, and recent headlines. Say in at most 30 words what the headlines suggest is behind the move, or say plainly that the headlines don't explain it.
Use only the headlines given; don't invent news. Never say buy, sell, or what the price will do next. No preamble, no quotes, one line.`;

async function ask(prompt) {
  client ||= new Anthropic();
  const msg = await client.beta.messages.create({
    model: MODEL, max_tokens: 2000, system: SYSTEM,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    messages: [{ role: 'user', content: prompt }],
  });
  if (msg.stop_reason === 'refusal') return null;
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

const lines = (items) => items.map((i) => `- ${i.title} (${i.source || 'news'}, ${i.at.slice(0, 16).replace('T', ' ')} UTC)`).join('\n') || '- (no headlines in the last two days)';

/** Why one stock is moving, from its headlines. */
export function aiWhy(row, items) {
  if (!aiEnabled()) return Promise.resolve(null);
  return cached('ai:' + row.name, 30 * 60e3, () => ask(
    `${row.name}${row.company ? ` (${row.company})` : ''}: ${row.chgPct > 0 ? '+' : ''}${row.chgPct}% today; the board reads it as ${row.dir > 0 ? 'bullish' : 'bearish'}${row.buildup ? `, futures OI: ${row.buildup}` : ''}.\nHeadlines:\n${lines(items)}`));
}

/** The market's mood: NIFTY, BANKNIFTY, VIX, breadth and the day's market headlines. */
export function aiMood(m, items) {
  if (!aiEnabled()) return Promise.resolve(null);
  return cached('ai:mood', 30 * 60e3, () => ask(
    `The market (India): NIFTY ${m.nifty ?? '?'}%, BANKNIFTY ${m.banknifty ?? '?'}%, India VIX ${m.vix ?? '?'}% today. ` +
    `F&O stocks: ${m.bullish} bullish, ${m.bearish} bearish, ${m.choppy} choppy.\nMarket headlines:\n${lines(items)}`));
}
