# ZoneBoard

A live board of the strongest bullish and bearish F&O stocks, each with its
order block, support, resistance and liquidity level, built on Zerodha Kite
Connect. For personal use: it ranks and marks, it does not tell you what to
trade. Trading in equity derivatives carries a high risk of loss.

## What it does

Every minute, 09:15–15:30 IST:

1. **Quotes** every stock in the F&O segment and its nearest future (about 440 instruments, one call).
2. **Scores** each stock 0–100 in its direction:
   - **move**: today's change against its usual daily move (14-day ATR)
   - **hold**: where it sits in today's range (a bull near the high)
   - **trend**: how much of the range is one-way travel
   - **OI**: futures open interest against yesterday's close, read as
     long build-up, short build-up, short covering or long unwinding
   - **volume**: today's volume against the 20-day average
   A stock that is chopping, or has given its move back, scores 0 and stays off the board.
3. **Ranks** the top 20 each side and, for the strongest 10 each side, reads the
   last two sessions' 5-minute candles to mark:
   - **order block**: the last opposite candle before an impulsive move that
     broke the latest swing (unbroken since)
   - **support / resistance**: the nearest swing levels
   - **liquidity**: the next swing beyond, where the other side's stops rest
4. **Pushes** the board to the page over Server-Sent Events.

Once a day after sign-in it reads 45 days of daily candles per stock (ATR,
average volume) and yesterday's futures OI. That takes a few minutes at Kite's
rate limits and is cached for the day.

## Trade plans

From 09:20 to 14:30, the first time a stock on the board has a setup, it gets one plan for the day:

- **setup** on the bullish board with an unbroken order block below price (bearish: the mirror)
- **entry** price comes back into the order block: entry at the zone's top (bearish: its bottom)
- **stop** just past the liquidity level beyond the zone; **target** entry + 2 × risk
- **option** the at-the-money call (bullish) or put (bearish), nearest expiry unless it is two
  trading days or less away, then the next one; priced each minute
- **NIFTY and BANKNIFTY** get a direction only when the index move and market breadth agree, and
  then a plan by the same rule
- status runs waiting → in trade → target / stopped, or closed at 15:15, or not triggered

The levels are mechanical. They are not advice, and they are not a forecast.

### Backtest

`node scripts/backtest.mjs --files data/candles data/candles-live --out data/backtest.json` replays the
same rules candle by candle on saved data; with a Kite token,
`KITE_API_KEY=… KITE_ACCESS_TOKEN=… node scripts/backtest.mjs --kite --days 60 --out data/backtest.json`
replays every F&O stock over the last 60 days. The board shows the latest backtest above the plans.
On the two sessions saved so far (16 stocks) the rules lost: 8 triggered, 1 target, 6 stops,
average −0.48R. Run the 60-day test before trusting any plan.

## Deploying on Render

1. Push this repository to GitHub.
2. Render → New → Blueprint → pick the repository. It reads `render.yaml`.
3. Fill in `SITE_PASSWORD`, `ADMIN_EMAIL`, `BASE_URL` (the `onrender.com` address it gives you).
   Leave the Kite keys empty to start: the site shows the saved board from 18 Nov.
4. With a Kite Connect app: set `KITE_API_KEY`, `KITE_API_SECRET`, and in the Kite app the redirect
   URL `BASE_URL/callback`. Each morning, sign in on the site and press **Connect Zerodha**.

## The website

- `/` landing page, pricing and FAQ; `/terms`, `/privacy`, `/refunds`, `/disclaimer` (drafts: fill in the bracketed details and have a lawyer check them).
- `/login` Google sign-in. `/checkout` Razorpay payment for a monthly or yearly plan.
- `/app` the board. Members get the live board; everyone else gets a blurred sample with made-up figures,
  generated on the server, so no real data reaches a visitor without a plan.
- `/admin/kite` the daily Zerodha sign-in that feeds the board, for `ADMIN_EMAIL` only.

### Environment

| Variable | What it is |
| --- | --- |
| `SITE_NAME` | Brand shown everywhere (default ZoneBoard) |
| `BASE_URL` | Public address, e.g. `https://zoneboard.in` (sessions are Secure cookies when this is https) |
| `SESSION_SECRET` | 32+ random characters; keep it secret and stable |
| `ADMIN_EMAIL` | The Google account allowed to connect Zerodha |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client; redirect URI `BASE_URL/auth/google/callback` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay API keys (test keys first) |
| `PRICE_MONTHLY`, `PRICE_YEARLY` | Rupees (default 799 and 5999) |
| `KITE_API_KEY`, `KITE_API_SECRET` | Kite Connect app; redirect URL `BASE_URL/callback` |
| `DATA_DIR` | Where users, orders and tokens are kept (default `./data`) |
| `DEV_LOGIN=1` | Email sign-in and free test plans without Google or Razorpay. **Never in production.** |

`npm run demo` runs the whole site locally on a saved board with `DEV_LOGIN` on.

## Run it

Needs Node 20+ and a **Kite Connect** app (developers.kite.trade; a paid
subscription is needed for market data). In the app settings set the redirect
URL to `http://localhost:8080/callback`.

```bash
KITE_API_KEY=xxxx KITE_API_SECRET=yyyy npm start
# open http://localhost:8080 and press "Sign in with Zerodha"
```

Kite access tokens end each morning, so sign in once a day.

Without Kite, `npm run demo` serves a saved board from 17 Nov 2026.

## Files

- `src/engine.mjs`: scoring, ranking, swings, order blocks, levels. Pure functions.
- `src/kite.mjs`: Kite Connect client (login, instruments, quote, historical), paced to Kite's limits.
- `server.mjs`: daily preparation, the minute loop, the board API and stream.
- `public/index.html`: the board.
- `scripts/snapshot.mjs`: builds a board from saved Kite responses (testing, demos).
- `test/`: `npm test`.

## Limits

- Exchange holidays are not known to it: on a holiday it shows the last session.
- Order blocks and liquidity follow one common definition; other traders draw them differently.
- Kite market data is for your own use. Showing it to paying users needs a data
  licence from the exchange; check before selling access.
