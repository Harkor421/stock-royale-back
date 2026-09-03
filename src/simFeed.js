// ============================================================================
// simFeed.js — a synthetic tape, for developing the battlefield without a key
// and without waiting for the opening bell. NEVER used when the real feed is
// running: every event it produces is stamped `sim: true` upstream so the HUD
// can label it.
//
// Each ticker follows a mean-reverting random walk with fat-tailed jumps and a
// slow "regime" drift, so rounds actually produce a spread of winners instead
// of eight flat lines.
// ============================================================================

import { TICKERS } from './config.js'

const SEED_PRICE = {
  NVDA: 184.2, TSLA: 331.7, AAPL: 229.4, AMZN: 213.8,
  META: 612.5, MSFT: 448.9, GOOGL: 186.3, AMD: 158.6,
}

export function createSimFeed({ onTrade }) {
  const st = TICKERS.map((t) => ({
    symbol: t.symbol,
    price: SEED_PRICE[t.symbol] || 100,
    drift: (Math.random() - 0.5) * 0.00035, // per-tick regime
    vol: 0.0006 + Math.random() * 0.0006,
  }))
  let timer = null

  function tick() {
    for (const s of st) {
      // regime slowly wanders so the leaderboard reshuffles between rounds
      if (Math.random() < 0.004) s.drift = (Math.random() - 0.5) * 0.00045
      const prints = 1 + ((Math.random() * 3) | 0)
      for (let k = 0; k < prints; k++) {
        const shock = Math.random() < 0.012 ? (Math.random() - 0.5) * 0.006 : 0
        const r = s.drift + (Math.random() - 0.5) * 2 * s.vol + shock
        s.price = Math.max(1, s.price * (1 + r))
        // odd lots most of the time, a block print now and then
        const size =
          Math.random() < 0.02
            ? 400 + Math.floor(Math.random() * 3000)
            : 1 + Math.floor(Math.random() * 120)
        onTrade({
          symbol: s.symbol,
          price: Math.round(s.price * 100) / 100,
          size,
          ts: Date.now(),
        })
      }
    }
  }

  return {
    start() {
      console.warn('[sim] SYNTHETIC TAPE — prices are made up. Do not broadcast this as live.')
      timer = setInterval(tick, 140)
    },
    stop() {
      clearInterval(timer)
    },
    get connected() {
      return timer !== null
    },
  }
}
