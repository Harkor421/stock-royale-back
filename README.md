# 🪖 Stock Royale — Backend

The live tape behind [**Stock Royale**](https://github.com/Harkor421/stock-royale-front): eight US mega-caps fight a **5-minute battle royale**, and every real print on the tape becomes a soldier, a tank or a bomb on the frontend's 3D battlefield.

- **Real prints, not candles.** One Finnhub WebSocket carries every trade for `NVDA TSLA AAPL AMZN META MSFT GOOGL AMD`.
- **Buy or sell is inferred by the tick rule** — an uptick means the aggressor lifted the offer (a buy, green), a downtick means they hit the bid (a sell, red), a flat print carries the previous side. Exchanges don't publish the aggressor, so this is the standard approximation; it's what makes the green-vs-red armies mean something.
- **Everyone starts each round at 0.00%.** A ticker's score is its % change from the price it held when the round's clock started, so a $150 stock and a $600 stock fight on even ground. Highest % change at the bell wins.
- **Rounds are wall-clock aligned** (…:00, :05, :10 …), so every viewer in the world sees the same round boundaries and the same winner at the same instant.
- **Only runs while the tape is live** — pre-market, regular hours and after hours (04:00–20:00 ET). Overnight and on weekends it emits a `session` event with a countdown instead of crowning a winner on a frozen tape.
- The API key lives **only here**. The frontend just consumes our WebSocket.

## Setup

```bash
npm install
cp .env.example .env      # then put your key in it
```

Get a free key at [finnhub.io/register](https://finnhub.io/register). `.env` is git-ignored — never commit it.

```
FINNHUB_API_KEY=your-key
PORT=8080
ROUND_MS=300000     # 5 minutes
```

## Run

```bash
npm start           # live tape
npm run sim         # synthetic tape — develop the battlefield at 3am, no key needed
```

The hub listens on `ws://localhost:8080`. Connect and you immediately get a `hello` snapshot (roster, current round, standings, recent winners), then the live stream.

JSON for anything that isn't a browser: `GET /state`, `GET /history`.

## The event stream

Every message is one JSON object with a `type`. This is the whole contract the frontend renders — nothing else crosses the wire.

| Event | When | What the battlefield does with it |
| --- | --- | --- |
| `hello` | on connect | Roster + colors, round clock, standings, past winners |
| `trade` | every (throttled) print | Spawns that army's troops — green for a buy, crimson bears for a sell |
| `standings` | 5× / second | Moves every army's frontline, updates the leaderboard |
| `roundStart` | every 5 min | Wipes the field, everyone back to 0.00% |
| `roundEnd` | every 5 min | **Winner announcement**: banner, fireworks, podium |
| `session` | at 04:00 / 09:30 / 16:00 / 20:00 ET | Switches the HUD between live and a closed-market countdown |

`trade` carries `{symbol, side, price, size, notional, bucket, pct}`. The bucket is the print's size class and decides what shows up on the field:

| Bucket | Notional | On the field |
| --- | --- | --- |
| `shrimp` | < $25K | Soldiers charge the line |
| `fish` | ≥ $25K | A squad + a floating price tag |
| `dolphin` | ≥ $150K | An APC rolls in and shoves the front |
| `whale` | ≥ $500K | A tank + a jet, an explosion, a camera shake |

### Throttling

A mega-cap can print hundreds of times a second and no eye can read that. Ordinary prints are capped at 8/second per symbol and blocks at 4/second, while **whales always pass** — they're the moments worth seeing. Throttled prints still count fully in the standings; only their soldier spawn is skipped.

## Deploy to Railway

It holds an open WebSocket to the feed and runs a round clock, so it needs a
long-lived process — Vercel's serverless functions can't host it. The server
binds `process.env.PORT` and answers `GET /`, so Railway deploys it as-is.

**Live: `wss://stock-royale-back-production.up.railway.app`** — the Railway
project `stock-royale` is connected to this repo, so a push to `master` ships it.

1. New Project → Deploy from GitHub repo → `stock-royale-back`.
2. Add the variable **`FINNHUB_API_KEY`**.
3. Networking → generate a domain. Your WebSocket endpoint is `wss://<domain>`.

Then point the frontend at it with `VITE_BACKEND_URL=wss://<domain>`.

> The deployed instance is currently on **`SIM=1`** — a synthetic tape — because
> it has no key yet. It reports `sim: true` in its `hello` snapshot and the
> frontend puts a gold warning on screen. Set `FINNHUB_API_KEY` and drop `SIM`
> to put it on the real market.

## Maintenance

`src/marketHours.js` carries a hard-coded list of US market holidays and half-days through **2027**. Add the next year's dates when they're published, or the game will try to run rounds on a closed tape.
