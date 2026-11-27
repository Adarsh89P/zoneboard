// Upstox API client with the same shape as the Kite client (src/kite.mjs), so the scanner can
// use either broker: login, F&O list, option chains, quotes and candles. Upstox's data APIs are
// free with an Upstox account.
//
// The server speaks Kite's names ('NSE:SBIN', 'NFO:<future>', 'NSE:NIFTY 50'); this client maps
// them to Upstox instrument keys ('NSE_EQ|INE…', 'NSE_FO|12345', 'NSE_INDEX|Nifty 50') using the
// day's instrument file, and returns quotes in Kite's shape (ohlc.close = yesterday's close).
//
// Rate limits: 50/s, 500/min and 2000 per 30 minutes. Requests are spaced to stay inside them,
// and past days' candles are cached for the day, so each scan only fetches today's.
import zlib from 'node:zlib';

const API = process.env.UPSTOX_API_URL || 'https://api.upstox.com';
const INSTRUMENTS = process.env.UPSTOX_INSTRUMENTS_URL || 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
const INDEX = { 'NIFTY 50': 'NSE_INDEX|Nifty 50', 'NIFTY BANK': 'NSE_INDEX|Nifty Bank', 'INDIA VIX': 'NSE_INDEX|India VIX' };

/** IST calendar date of a time in ms. */
const istDay = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
/** 'YYYY-MM-DD' moved by n calendar days. */
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

export class Upstox {
  constructor(apiKey, apiSecret, redirectUri, accessToken = '') {
    this.apiKey = apiKey; this.apiSecret = apiSecret; this.redirectUri = redirectUri; this.accessToken = accessToken;
    this.broker = 'Upstox';
    this.vixToken = INDEX['INDIA VIX'];
    this.indexTokens = { NIFTY: INDEX['NIFTY 50'], BANKNIFTY: INDEX['NIFTY BANK'] };
    this.keys = new Map();      // Kite-style name → Upstox instrument key
    this.names = new Map();     // instrument key → Kite-style name
    this.rows = null;           // the day's instrument file
    this.past = new Map();      // candle cache for finished days
    this.sent = [];             // request times, for the 30-minute limit
    this.next = 0;
  }

  loginUrl() {
    const q = new URLSearchParams({ response_type: 'code', client_id: this.apiKey, redirect_uri: this.redirectUri });
    return `https://api.upstox.com/v2/login/authorization/dialog?${q}`;
  }

  /** Trades the code from Upstox's redirect for the day's access token (valid until 03:30 next day). */
  async createSession(code) {
    const body = new URLSearchParams({ code, client_id: this.apiKey, client_secret: this.apiSecret, redirect_uri: this.redirectUri, grant_type: 'authorization_code' });
    const r = await this.#req('POST', '/v2/login/authorization/token', { body, form: true, auth: false });
    this.accessToken = r.access_token;
    return r;
  }

  /** The day's NSE instrument file (equities, indices, futures and options). */
  async #instruments() {
    if (this.rows) return this.rows;
    const res = await fetch(INSTRUMENTS);
    if (!res.ok) throw Object.assign(new Error(`Upstox instruments ${res.status}`), { status: res.status });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    this.rows = JSON.parse(text);
    for (const r of this.rows) {
      const name = r.segment === 'NSE_EQ' && r.instrument_type === 'EQ' ? 'NSE:' + r.trading_symbol
        : r.segment === 'NSE_FO' ? 'NFO:' + r.trading_symbol : null;
      if (name) { this.keys.set(name, r.instrument_key); this.names.set(r.instrument_key, name); }
    }
    for (const [n, k] of Object.entries(INDEX)) { this.keys.set('NSE:' + n, k); this.names.set(k, 'NSE:' + n); }
    return this.rows;
  }

  /** Stock futures (nearest expiry, and the next) with their cash-market keys, as Kite's client returns them. */
  async fnoUniverse(today = new Date()) {
    const rows = await this.#instruments(), day = istDay(today.getTime());
    const cash = new Map(rows.filter((r) => r.segment === 'NSE_EQ' && r.instrument_type === 'EQ').map((r) => [r.trading_symbol, r]));
    const byName = new Map();
    for (const r of rows) {
      if (r.segment !== 'NSE_FO' || r.instrument_type !== 'FUT' || r.underlying_type !== 'EQUITY') continue;
      if (istDay(r.expiry) < day || !cash.has(r.underlying_symbol)) continue;
      (byName.get(r.underlying_symbol) || byName.set(r.underlying_symbol, []).get(r.underlying_symbol)).push(r);
    }
    return [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => {
      const [near, next] = list.sort((a, b) => a.expiry - b.expiry), eq = cash.get(name);
      return {
        name, fut: near.trading_symbol, fut_token: near.instrument_key, lot: +near.lot_size, token: eq.instrument_key, company: eq.name || undefined,
        ...(next ? { fut2: next.trading_symbol, fut2_token: next.instrument_key } : {}),
      };
    });
  }

  /** Option strikes, two nearest expiries each: { NAME: { 'YYYY-MM-DD': { CE: [{symbol, strike, lot}], PE } } }. */
  optionChains(names, today = new Date()) {
    const want = new Set(names), day = istDay(today.getTime()), out = {};
    for (const r of this.rows || []) {
      if (r.segment !== 'NSE_FO' || (r.instrument_type !== 'CE' && r.instrument_type !== 'PE') || !want.has(r.underlying_symbol)) continue;
      const exp = istDay(r.expiry);
      if (exp < day) continue;
      ((out[r.underlying_symbol] ||= {})[exp] ||= { CE: [], PE: [] })[r.instrument_type].push({ symbol: r.trading_symbol, strike: +r.strike_price, lot: +r.lot_size });
    }
    for (const n in out) for (const e of Object.keys(out[n]).sort().slice(2)) delete out[n][e];
    return out;
  }

  /** Quotes keyed by the Kite-style names asked for: { last_price, volume, oi, ohlc: {open, high, low, close: yesterday's close} }. */
  async quote(instruments) {
    if (!this.keys.size) await this.#instruments();
    const ask = instruments.map((n) => [n, this.keys.get(n)]).filter(([, k]) => k), out = {};
    for (let i = 0; i < ask.length; i += 500) {
      const part = ask.slice(i, i + 500), byKey = new Map(part.map(([n, k]) => [k, n]));
      const data = await this.#req('GET', '/v2/market-quote/quotes?instrument_key=' + encodeURIComponent(part.map(([, k]) => k).join(',')));
      for (const q of Object.values(data || {})) {
        const name = byKey.get(q.instrument_token);
        if (!name) continue;
        const prevClose = q.net_change != null ? q.last_price - q.net_change : q.ohlc?.close;
        out[name] = { last_price: q.last_price, volume: q.volume, oi: q.oi, timestamp: q.timestamp,
          ohlc: q.ohlc ? { open: q.ohlc.open, high: q.ohlc.high, low: q.ohlc.low, close: Math.round(prevClose * 100) / 100 } : undefined };
      }
    }
    return out;
  }

  /**
   * Candles as { t, o, h, l, c, v, oi }, oldest first. interval: 'day' or 'Nminute' (Kite's names).
   * from/to: 'YYYY-MM-DD' (anything after the date is ignored). A range reaching today adds
   * today's candles from the intraday endpoint; finished days are cached for the day.
   */
  async historical(key, interval, from, to) {
    const [unit, n] = interval === 'day' ? ['days', 1] : ['minutes', +interval.replace('minute', '') || 1];
    const today = istDay(Date.now()), f = from.slice(0, 10), t = to.slice(0, 10);
    const lastPast = t >= today ? istDay(Date.now() - 864e5) : t;
    let candles = [];
    if (f <= lastPast) {
      const ck = [key, unit, n, f, lastPast, today].join('|');
      if (!this.past.has(ck)) {
        // minute candles come at most a month per call: walk back in 28-day steps
        const step = unit === 'minutes' ? 28 : 3650, parts = [];
        for (let end = lastPast; end >= f;) {
          const s = addDays(end, -(step - 1)) < f ? f : addDays(end, -(step - 1));
          const r = await this.#req('GET', `/v3/historical-candle/${encodeURIComponent(key)}/${unit}/${n}/${end}/${s}`);
          parts.push(...(r?.candles || []));
          end = addDays(s, -1);
        }
        this.past.set(ck, parts);
        if (this.past.size > 2000) this.past.delete(this.past.keys().next().value);
      }
      candles.push(...this.past.get(ck));
    }
    if (t >= today) {
      const r = await this.#req('GET', `/v3/historical-candle/intraday/${encodeURIComponent(key)}/${unit}/${n}`);
      candles.push(...(r?.candles || []));
    }
    const seen = new Map(candles.map((c) => [c[0], c]));
    return [...seen.values()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map((c) => ({ t: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5], oi: c[6] }));
  }

  /** Spaces requests: at least 150 ms apart (≤ 400 a minute) and at most 1900 in any 30 minutes. */
  async #pace() {
    for (;;) {
      const now = Date.now();
      this.sent = this.sent.filter((t) => now - t < 30 * 60e3);
      const at = this.sent.length >= 1900 ? this.sent[0] + 30 * 60e3 : Math.max(now, this.next);
      if (at <= now) break;
      await new Promise((r) => setTimeout(r, at - now));
    }
    const now = Date.now();
    this.next = now + 150; this.sent.push(now);
  }

  async #req(method, path, { body, form = false, auth = true } = {}, attempt = 0) {
    await this.#pace();
    const headers = { Accept: 'application/json' };
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (auth) headers.Authorization = `Bearer ${this.accessToken}`;
    const res = await fetch(API + path, { method, headers, body });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return this.#req(method, path, { body, form, auth }, attempt + 1);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.status === 'error') {
      const err = j.errors?.[0] || {};
      const e = new Error(err.message || j.message || `Upstox ${res.status}`);
      // the server reads Kite's error shape: a 403 TokenException means "sign in again"
      e.status = res.status === 401 ? 403 : res.status;
      e.kiteType = res.status === 401 ? 'TokenException' : err.errorCode;
      throw e;
    }
    return method === 'POST' && path.includes('/login/') ? j : j.data;
  }
}
