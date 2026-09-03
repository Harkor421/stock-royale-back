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

Get a free key at [finnhub.io/register](https://finnhub.io/register) — email only, no card, and the key is on your dashboard the moment you sign up. `.env` is git-ignored — never commit it.

> ⚠️ **One socket per key.** Finnhub's free plan allows a single live WebSocket
> per API key. Start a second backend on the same key — local dev while the
> deploy is running, say — and it kicks the first one off; both then reconnect
> in a loop until Finnhub answers `429` and neither receives anything. The feed
> backs off for minutes when it detects this, but the fix is to use `npm run
> sim` for local work, or a second key.

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

## Holder detection

This is the part that has cost the most debugging time, so here is everything
that is actually true about it on Robinhood Chain.

### The indexer will not talk to you

- **`robinhoodchain.blockscout.com` sits behind a Cloudflare challenge.** From a
  browser it works; from a server it answers **403** with an HTML *"Just a
  moment…"* page. Nothing identifies itself as an error — the crawl just comes
  back with nothing, which downstream looks exactly like *a token with no
  holders*. That is the failure mode to recognise.
- **`api.blockscout.com/4663` (the Pro host) answers 402 without a key.** It is
  the default here because a 402 at least says what is wrong.

So: **set `BLOCKSCOUT_API_KEY`** and holder detection works through the indexer.
Without one, it falls through to the chain.

### Falling back to the chain itself

With no indexer available, holders are rebuilt from `Transfer` logs over the
public RPC — every ERC-20 balance is the sum of its transfers, so replaying them
reconstructs the holder set exactly, from ground truth, with no third party and
no key. Verified: 24,833 holders rebuilt for a live token this way.

Two things to know before relying on it:

- **The public RPC is not an archive node.** Historical *state* is pruned after
  roughly ten minutes of blocks, so `eth_getCode` at an old block errors and the
  deployment block cannot be binary-searched. Historical *logs* are still
  served, which is why this works at all. The start of history is found by
  walking backwards until the token goes quiet.
- **It replays history, so it suits a young token.** A heavily traded one took
  ~9 minutes over 400k blocks. Set **`TOKEN_START_BLOCK`** to the token's first
  block and it becomes cheap and incremental.

### Pools and bonding curves are not holders

On a launchpad token the **bonding curve holds most of the supply**, and after
graduation the **AMM pool** does. Neither is a person. Miss one and it collects
the largest slice of every airdrop — money set on fire.

Three overlapping rules, so no single one being wrong lets a curve through:

1. Any **contract** holding ≥ `POOL_MIN_PCT` (0.5%) of supply is a pool.
2. The **single largest contract holder**, whatever its size.
3. **Known addresses re-checked on-chain**, independent of the indexer. The
   important one is `0x8366a39cc670b4001a1121b8f6a443a643e40951` — Robinhood
   Chain's **Uniswap v4 singleton PoolManager**. All v4 liquidity for every
   token lives in that one contract, so it shows up as one enormous holder on
   any v4 token. It ranked third on the live token tested above.

Rule 1 is the one that survives a launchpad shipping a v2: it needs no prior
knowledge of any address.

### The chain decides the amounts

Balances for everyone about to be paid are **re-read from the chain** before the
split (`VERIFY_ONCHAIN`). The indexer decides *who* is in the list; the chain
decides *how much*. A lagging index then costs someone their place in the list,
and never costs anyone the wrong number of shares.

### It refuses rather than guesses

- A crawl covering less than `MIN_SUPPLY_COVERAGE` (40%) of supply is a
  **truncated crawl**, not a token with a tiny float. Paying over it would hand
  the airdrop to whichever addresses landed on the first page. Rejected.
- A **collapse in the holder count** versus the previous crawl (to under 30%) is
  an indexer problem far more often than a real exodus. Rejected.
- A **stale snapshot** (older than `HOLDERS_STALE_MS`) is never distributed over.

### Seeing it

```
GET /holders                    what the live snapshot found, and what it excluded
GET /holders?token=0x…          probe ANY token without configuring it
```

The probe reports every address it excluded **and why** — pool, curve, contract,
below the floor, above the cap. Point it at a launchpad token before you point
real money at it.

## Maintenance

`src/marketHours.js` carries a hard-coded list of US market holidays and half-days through **2027**. Add the next year's dates when they're published, or the game will try to run rounds on a closed tape.
