// ============================================================================
// finnhub.js — the live tape.
//
// One WebSocket to Finnhub carries every print for all 8 tickers:
//   -> {"type":"subscribe","symbol":"NVDA"}
//   <- {"type":"trade","data":[{"s":"NVDA","p":184.21,"v":100,"t":1788…}]}
//
// Reconnects with backoff and re-subscribes; the caller just gets onTrade().
// The API key never leaves this process — the frontend only ever talks to our
// own WebSocket hub.
// ============================================================================

import WebSocket from 'ws'
import { config, SYMBOLS } from './config.js'

const ENDPOINT = 'wss://ws.finnhub.io'

export function createFinnhubFeed({ onTrade, onStatus }) {
  let ws = null
  let backoff = 1000
  let stopped = false
  let heartbeat = null
  let lastMessageAt = 0

  function connect() {
    if (stopped) return
    ws = new WebSocket(`${ENDPOINT}?token=${config.finnhubKey}`)

    ws.on('open', () => {
      backoff = 1000
      lastMessageAt = Date.now()
      for (const s of SYMBOLS) ws.send(JSON.stringify({ type: 'subscribe', symbol: s }))
      console.info(`[finnhub] connected — subscribed to ${SYMBOLS.join(', ')}`)
      onStatus?.({ connected: true })
    })

    ws.on('message', (raw) => {
      lastMessageAt = Date.now()
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.type === 'ping') return
      if (msg.type === 'error') {
        console.error('[finnhub] error:', msg.msg)
        return
      }
      if (msg.type !== 'trade' || !Array.isArray(msg.data)) return
      for (const t of msg.data) {
        const price = Number(t.p)
        const size = Number(t.v)
        if (!(price > 0) || !(size > 0)) continue
        onTrade({ symbol: t.s, price, size, ts: Number(t.t) || Date.now() })
      }
    })

    ws.on('close', () => {
      onStatus?.({ connected: false })
      retry('closed')
    })
    ws.on('error', (err) => {
      console.error('[finnhub] socket error:', err.message)
    })

    // Finnhub goes quiet outside of trading; only treat a long silence as dead
    // while the tape should be running (the caller decides via shouldBeLive).
    clearInterval(heartbeat)
    heartbeat = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > 90_000) {
        console.warn('[finnhub] 90s of silence — recycling the socket')
        try { ws.terminate() } catch {}
      }
    }, 30_000)
  }

  function retry(why) {
    if (stopped) return
    const wait = backoff
    backoff = Math.min(backoff * 2, 30_000)
    console.warn(`[finnhub] ${why} — reconnecting in ${wait}ms`)
    setTimeout(connect, wait)
  }

  return {
    start() {
      stopped = false
      connect()
    },
    stop() {
      stopped = true
      clearInterval(heartbeat)
      try { ws?.close() } catch {}
    },
    get connected() {
      return ws?.readyState === WebSocket.OPEN
    },
  }
}

/**
 * REST snapshot — used to seed a round's baseline when a ticker hasn't printed
 * yet (common right at the pre-market open). Free tier: 60 calls/minute, and
 * we make at most 8 per round.
 */
export async function fetchQuotes(symbols = SYMBOLS) {
  const out = new Map()
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const r = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${config.finnhubKey}`,
          { signal: AbortSignal.timeout(6000) }
        )
        if (!r.ok) return
        const j = await r.json()
        if (j && j.c > 0) out.set(s, { price: j.c, prevClose: j.pc, high: j.h, low: j.l })
      } catch {
        /* a missing seed just means we wait for the first print */
      }
    })
  )
  return out
}
