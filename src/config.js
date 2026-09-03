// ============================================================================
// config.js — every tunable of the backend in one place.
// The ticker roster (and its colors) lives HERE, not in the frontend, so the
// two never disagree: the frontend receives the roster in the `hello` message.
// ============================================================================

import 'dotenv/config'

export const config = {
  finnhubKey: (process.env.FINNHUB_API_KEY || '').trim(),
  port: Number(process.env.PORT || 8080),
  /** Round length in ms. Rounds are aligned to the wall clock (…:00, :05, :10). */
  roundMs: Number(process.env.ROUND_MS || 5 * 60 * 1000),
  /** Force the synthetic feed (dev / demo). Never use for a real broadcast. */
  sim: process.env.SIM === '1',
  /** Ordinary prints forwarded per symbol per second (see game.js throttle). */
  maxTradesPerSec: Number(process.env.MAX_TRADES_PER_SEC || 8),
  /** Block prints (dolphin) forwarded per symbol per second. Whales always pass. */
  maxBlocksPerSec: Number(process.env.MAX_BLOCKS_PER_SEC || 4),
  /** How often standings are pushed to clients. */
  standingsHz: Number(process.env.STANDINGS_HZ || 5),
  /** Rolling window (seconds) the buy/sell "pressure" bars aggregate over. */
  windowSec: Number(process.env.WINDOW_SEC || 30),
  /** Winners kept in memory for the hall of fame. */
  historyLen: Number(process.env.HISTORY_LEN || 24),
}

/**
 * The roster. 8 mega-caps: always liquid, so every round has real action.
 * `color` is the army's faction color on the battlefield — deliberately clear
 * of the bear crimson (#8b0e18) so buy troops never read as sell troops.
 */
export const TICKERS = Object.freeze([
  { symbol: 'NVDA', name: 'Nvidia', color: '#76b900' },
  { symbol: 'TSLA', name: 'Tesla', color: '#ff6b3d' },
  { symbol: 'AAPL', name: 'Apple', color: '#d8dbe2' },
  { symbol: 'AMZN', name: 'Amazon', color: '#ff9f1c' },
  { symbol: 'META', name: 'Meta', color: '#2f7bff' },
  { symbol: 'MSFT', name: 'Microsoft', color: '#00d4c8' },
  { symbol: 'GOOGL', name: 'Alphabet', color: '#ffd447' },
  { symbol: 'AMD', name: 'AMD', color: '#c46bff' },
])

export const SYMBOLS = TICKERS.map((t) => t.symbol)

/**
 * Print-size buckets, in USD notional (price * shares).
 *
 * Calibrated against the REAL tape, not a guess: watching the live feed, a
 * typical mega-cap print is a 40–100 share odd lot worth $13K–$40K, and $69K is
 * already a big one. The first cut of these thresholds (fish $25K / dolphin
 * $150K / whale $500K) meant almost every real print landed in the smallest
 * bucket, so the battlefield showed infantry and nothing else — no armour, no
 * aircraft, no explosions, for minutes at a time.
 *
 *   shrimp  soldiers        fish  a squad + a price tag
 *   dolphin an APC          whale a tank, a jet, an explosion and a camera shake
 */
export const THRESH = Object.freeze({
  fish: Number(process.env.T_FISH || 10_000),
  dolphin: Number(process.env.T_DOLPHIN || 50_000),
  whale: Number(process.env.T_WHALE || 150_000),
})

export function classify(notional) {
  if (notional >= THRESH.whale) return 'whale'
  if (notional >= THRESH.dolphin) return 'dolphin'
  if (notional >= THRESH.fish) return 'fish'
  return 'shrimp'
}

if (!config.finnhubKey && !config.sim) {
  console.error(
    '[config] Missing FINNHUB_API_KEY.\n' +
      '         Get a free key at https://finnhub.io/register, then:\n' +
      '           cp .env.example .env   # and set FINNHUB_API_KEY\n' +
      '         Or run the synthetic feed for a dev round:  SIM=1 npm start'
  )
  process.exit(1)
}
