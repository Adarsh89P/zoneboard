# OB Scanner

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
