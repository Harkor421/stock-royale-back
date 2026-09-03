// ============================================================================
// game.js — the round engine. Turns a raw tape into a battle.
//
//  · Every print is classified buy/sell by the TICK RULE (uptick = aggressor
//    bought, downtick = aggressor sold, flat = carry the last side). Exchanges
//    don't publish the aggressor side, so this is the standard approximation —
//    it's what makes the green/red armies real rather than decorative.
//  · Each ticker's score in a round is its % change from the price it held at
//    the round's opening bell. Everyone starts at 0.00%, so a $5 stock and a
//    $900 stock fight on even ground.
//  · Rounds are 5 minutes long and aligned to the wall clock (…:00, :05, :10),
//    so every viewer everywhere sees the same round boundaries.
//  · Rounds only run while the tape is live (pre / regular / after hours).
//
// Emits the normalized event stream the frontend's battlefield consumes:
//   trade · standings · roundStart · roundEnd · session
// ============================================================================

import { config, TICKERS, classify } from './config.js'
import { sessionInfo } from './marketHours.js'
import { fetchQuotes } from './finnhub.js'

const W = config.windowSec
let eventSeq = 0
const nextId = () => `e${(eventSeq = (eventSeq + 1) % 1e9)}`

function makeSymbol(t) {
  return {
    symbol: t.symbol,
    name: t.name,
    color: t.color,
    price: 0,
    prevPrice: 0,
    lastSide: 'buy',
    baseline: 0, // price at the round's start — the thing everything is measured from
    pct: 0,
    prevClose: 0,
    high: 0,
    low: 0,
    trades: 0, // prints this round
    volume: 0, // shares this round
    notional: 0, // $ this round
    spark: [], // recent pct samples for the HUD sparkline
    // rolling window ring buffers (one slot per second)
    sec: 0,
    buyBuf: new Float64Array(W),
    sellBuf: new Float64Array(W),
    buyCnt: new Int32Array(W),
    sellCnt: new Int32Array(W),
    throttleSec: 0,
    throttleCount: 0,
    blockCount: 0,
  }
}

function roll(S, nowSec) {
  if (S.sec === 0) {
    S.sec = nowSec
    return
  }
  const gap = nowSec - S.sec
  if (gap <= 0) return
  if (gap >= W) {
    S.buyBuf.fill(0)
    S.sellBuf.fill(0)
    S.buyCnt.fill(0)
    S.sellCnt.fill(0)
  } else {
    for (let k = 1; k <= gap; k++) {
      const i = (S.sec + k) % W
      S.buyBuf[i] = 0
      S.sellBuf[i] = 0
      S.buyCnt[i] = 0
      S.sellCnt[i] = 0
    }
  }
  S.sec = nowSec
}

function windowSums(S) {
  let buy = 0
  let sell = 0
  let bc = 0
  let sc = 0
  for (let i = 0; i < W; i++) {
    buy += S.buyBuf[i]
    sell += S.sellBuf[i]
    bc += S.buyCnt[i]
    sc += S.sellCnt[i]
  }
  return { buy, sell, bc, sc }
}

export function createGame({ onEvent }) {
  /** @type {Map<string, ReturnType<makeSymbol>>} */
  const syms = new Map(TICKERS.map((t) => [t.symbol, makeSymbol(t)]))
  const roster = TICKERS.map((t) => ({ symbol: t.symbol, name: t.name, color: t.color }))

  let round = null
  let session = sessionInfo()
  let history = [] // most recent winners first
  let lastStandings = []
  let seq = 0
  let timer = null

  const emit = (e) => onEvent(e)

  // -- rounds ---------------------------------------------------------------

  /** Round boundaries are wall-clock aligned: the slot containing `ts`. */
  const slotStart = (ts) => Math.floor(ts / config.roundMs) * config.roundMs

  function roundMeta() {
    if (!round) return null
    return {
      id: round.id,
      seq: round.seq,
      startedAt: round.startedAt,
      endsAt: round.endsAt,
      lengthMs: config.roundMs,
      label: new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(round.startedAt)),
    }
  }

  async function startRound(at = Date.now()) {
    const startedAt = slotStart(at)
    round = {
      id: startedAt / config.roundMs,
      seq: ++seq,
      startedAt,
      endsAt: startedAt + config.roundMs,
    }
    // Seed anything that hasn't printed yet, so a ticker never sits at 0.00%
    // just because it was quiet for the first few seconds of the round.
    const missing = [...syms.values()].filter((S) => !(S.price > 0)).map((S) => S.symbol)
    if (missing.length && config.finnhubKey) {
      const quotes = await fetchQuotes(missing)
      for (const [symbol, q] of quotes) {
        const S = syms.get(symbol)
        if (!S) continue
        S.price = q.price
        S.prevPrice = q.price
        S.prevClose = q.prevClose || q.price
        S.high = S.low = q.price
      }
    }
    for (const S of syms.values()) {
      S.baseline = S.price || S.baseline
      S.pct = 0
      S.trades = 0
      S.volume = 0
      S.notional = 0
      S.high = S.price
      S.low = S.price
      S.spark = []
    }
    emit({ type: 'roundStart', ts: Date.now(), id: nextId(), round: roundMeta(), rows: standings() })
    console.info(`[game] round ${roundMeta().label} ET started — ${roster.length} armies on the field`)
  }

  function endRound() {
    if (!round) return
    const rows = standings()
    const ranked = [...rows].sort((a, b) => b.pct - a.pct || b.buyNotional - a.buyNotional)
    const traded = ranked.filter((r) => r.trades > 0)
    const winner = traded.length ? ranked[0] : null
    const result = {
      round: roundMeta(),
      winner: winner
        ? {
            symbol: winner.symbol,
            name: winner.name,
            color: winner.color,
            pct: winner.pct,
            price: winner.price,
            lead: ranked[1] ? winner.pct - ranked[1].pct : 0,
            buyNotional: winner.buyNotional,
            trades: winner.trades,
          }
        : null,
      podium: ranked.slice(0, 3).map((r) => ({ symbol: r.symbol, color: r.color, pct: r.pct })),
      rows: ranked,
      endedAt: Date.now(),
    }
    history = [result, ...history].slice(0, config.historyLen)
    emit({ type: 'roundEnd', ts: Date.now(), id: nextId(), ...result })
    console.info(
      `[game] round ${result.round.label} ET won by ${winner ? `${winner.symbol} ${winner.pct >= 0 ? '+' : ''}${winner.pct.toFixed(2)}%` : 'nobody (no prints)'}`
    )
  }

  // -- the tape -------------------------------------------------------------

  /** One print off the tape. */
  function onTrade({ symbol, price, size, ts }) {
    const S = syms.get(symbol)
    if (!S || !(price > 0) || !(size > 0)) return
    if (!session.live) return // frozen tape: don't score it

    const nowSec = Math.floor(Date.now() / 1000)
    roll(S, nowSec)

    // tick rule: the aggressor lifted the offer (buy) or hit the bid (sell)
    let side = S.lastSide
    if (S.price > 0) {
      if (price > S.price) side = 'buy'
      else if (price < S.price) side = 'sell'
    }
    S.lastSide = side

    S.prevPrice = S.price
    S.price = price
    if (!S.baseline) S.baseline = price
    if (!S.high || price > S.high) S.high = price
    if (!S.low || price < S.low) S.low = price
    S.pct = S.baseline > 0 ? (price / S.baseline - 1) * 100 : 0

    const notional = price * size
    const i = nowSec % W
    if (side === 'buy') {
      S.buyBuf[i] += notional
      S.buyCnt[i]++
    } else {
      S.sellBuf[i] += notional
      S.sellCnt[i]++
    }
    S.trades++
    S.volume += size
    S.notional += notional

    // Forward the print — throttled per second so a fast tape can't flood the
    // wire. A mega-cap can print hundreds of times a second, and the eye can't
    // read that anyway; what must never be dropped is a block, because those
    // are the tanks. So: whales always pass, blocks get their own budget, and
    // ordinary prints share the rest. Dropped prints still count in the
    // standings — only their soldier spawn is skipped.
    const bucket = classify(notional)
    if (S.throttleSec !== nowSec) {
      S.throttleSec = nowSec
      S.throttleCount = 0
      S.blockCount = 0
    }
    const pass =
      bucket === 'whale' ||
      (bucket === 'dolphin' && S.blockCount < config.maxBlocksPerSec) ||
      S.throttleCount < config.maxTradesPerSec
    if (pass) {
      if (bucket === 'dolphin') S.blockCount++
      else S.throttleCount++
      emit({
        type: 'trade',
        ts: ts || Date.now(),
        id: nextId(),
        symbol,
        side,
        price,
        size,
        notional,
        bucket,
        pct: S.pct,
      })
    }
  }

  // -- standings ------------------------------------------------------------

  function standings() {
    const rows = []
    const nowSec = Math.floor(Date.now() / 1000)
    for (const S of syms.values()) {
      roll(S, nowSec) // age out seconds even for a ticker that has gone quiet
      const { buy, sell, bc, sc } = windowSums(S)
      const tot = buy + sell
      rows.push({
        symbol: S.symbol,
        name: S.name,
        color: S.color,
        price: S.price,
        baseline: S.baseline,
        pct: S.pct,
        high: S.high,
        low: S.low,
        trades: S.trades,
        volume: S.volume,
        notional: S.notional,
        buyNotional: buy,
        sellNotional: sell,
        buyCount: bc,
        sellCount: sc,
        pressure: tot > 0 ? (buy - sell) / tot : 0,
        spark: S.spark,
        rank: 0,
        advance: 0,
      })
    }
    rows.sort((a, b) => b.pct - a.pct || b.buyNotional - a.buyNotional)
    // advance: where each army sits between the round's worst and best performer.
    // 1 = holding the hill, 0 = pinned against the rim. The 0.05 floor stops a
    // dead-flat tape from turning rounding noise into a stampede.
    const best = rows[0]?.pct ?? 0
    const worst = rows[rows.length - 1]?.pct ?? 0
    const spread = Math.max(best - worst, 0.05)
    rows.forEach((r, i) => {
      r.rank = i + 1
      r.advance = (r.pct - worst) / spread
    })
    lastStandings = rows
    return rows
  }

  // -- clock ----------------------------------------------------------------

  function tick() {
    const now = Date.now()

    // session flips (open / close) drive whether rounds run at all
    const s = sessionInfo(now)
    if (s.state !== session.state) {
      session = s
      emit(s)
      console.info(`[game] session -> ${s.label}`)
      if (!s.live && round) {
        endRound()
        round = null
      }
    }

    if (!session.live) return
    if (!round) {
      startRound(now)
      return
    }
    if (now >= round.endsAt) {
      endRound()
      startRound(now)
      return
    }

    const rows = standings()
    for (const r of rows) {
      const S = syms.get(r.symbol)
      S.spark.push(Number(r.pct.toFixed(3)))
      if (S.spark.length > 90) S.spark.shift()
    }
    emit({ type: 'standings', ts: now, id: nextId(), round: roundMeta(), rows })
  }

  return {
    onTrade,
    roster,
    start() {
      session = sessionInfo()
      emit(session)
      if (session.live) startRound()
      const period = Math.max(100, Math.round(1000 / config.standingsHz))
      timer = setInterval(tick, period)
    },
    stop() {
      clearInterval(timer)
    },
    /** Everything a freshly connected client needs to render immediately. */
    snapshot() {
      return {
        type: 'hello',
        ts: Date.now(),
        id: nextId(),
        game: 'Stock Royale',
        roster,
        session,
        round: roundMeta(),
        rows: lastStandings.length ? lastStandings : standings(),
        history: history.map((h) => ({ round: h.round, winner: h.winner, podium: h.podium })),
        roundMs: config.roundMs,
        serverNow: Date.now(),
      }
    },
    get session() {
      return session
    },
    get history() {
      return history
    },
  }
}
