// ============================================================================
// db.js — durable memory. Every share of stock this game has ever handed out,
// who received it, in which round, and the transaction that carries it.
//
// Three collections:
//   payouts   one document per transfer — the audit trail, never aggregated away
//   holders   a running total per wallet, so the leaderboard is a read, not a scan
//   rounds    one document per decided round: winner, what was bought, what went out
//
// Amounts are stored BOTH in shares and in USD at the price the winning ticker
// held when the round ended. Shares of NVDA and shares of AAPL can't be ranked
// against each other; dollars can, and the leaderboard has to rank.
//
// Everything degrades gracefully: with no MONGO_URL the game runs exactly as
// before and the leaderboard simply reports what is in memory.
// ============================================================================

import { MongoClient } from 'mongodb'

export function createDb(url) {
  let client = null
  let db = null
  let payouts = null
  let holders = null
  let rounds = null
  let ready = false
  let lastError = null

  async function connect() {
    if (!url) {
      console.info('[db] no MONGO_URL — running without persistence')
      return false
    }
    try {
      client = new MongoClient(url, { serverSelectionTimeoutMS: 8000 })
      await client.connect()
      db = client.db()
      payouts = db.collection('payouts')
      holders = db.collection('holders')
      rounds = db.collection('rounds')

      // A payout is uniquely a (round, address) pair. The unique index is what
      // makes a retried or replayed round idempotent instead of paying the
      // leaderboard twice for one transfer.
      await payouts.createIndex({ roundId: 1, to: 1 }, { unique: true })
      await payouts.createIndex({ to: 1, ts: -1 })
      await payouts.createIndex({ ts: -1 })
      await holders.createIndex({ totalUsd: -1 })
      await rounds.createIndex({ roundId: -1 }, { unique: true })

      ready = true
      console.info('[db] connected — payouts, holders and rounds are persisted')
      return true
    } catch (e) {
      lastError = e.message
      console.error('[db] connect failed:', e.message, '— continuing without persistence')
      return false
    }
  }

  /**
   * Record one round's distribution. Writes the transfers, rolls each recipient's
   * running totals forward, and files the round itself.
   */
  async function recordDistribution({ round, ticker, name, usdPerUnit, items, buy, dryRun, demo }) {
    if (!ready || !items?.length) return
    const roundId = round?.id ?? Math.floor(Date.now() / 300_000)
    const ts = Date.now()
    try {
      // Insert the transfers. Duplicates (a replayed round) are skipped rather
      // than aborting the batch, so a partial retry can't lose the rest.
      const docs = items.map((it) => ({
        roundId,
        roundLabel: round?.label ?? null,
        ticker,
        to: it.to,
        amount: it.amount,
        usd: usdPerUnit ? it.amount * usdPerUnit : null,
        usdPerUnit: usdPerUnit ?? null,
        heldPct: it.pct,
        tx: it.tx,
        txUrl: it.txUrl,
        dryRun: !!dryRun,
        demo: !!demo,
        ts,
      }))
      let inserted = docs
      try {
        await payouts.insertMany(docs, { ordered: false })
      } catch (e) {
        // ordered:false reports the duplicates it skipped; the rest did land
        const dup = new Set((e.writeErrors || []).map((w) => w.index))
        inserted = docs.filter((_, i) => !dup.has(i))
        if (!e.writeErrors) throw e
      }

      if (inserted.length) {
        await holders.bulkWrite(
          inserted.map((d) => ({
            updateOne: {
              filter: { _id: d.to },
              update: {
                $inc: {
                  totalUsd: d.usd || 0,
                  payouts: 1,
                  [`byTicker.${d.ticker}.amount`]: d.amount,
                  [`byTicker.${d.ticker}.usd`]: d.usd || 0,
                  [`byTicker.${d.ticker}.count`]: 1,
                },
                $max: { lastAt: d.ts, lastHeldPct: d.heldPct },
                $min: { firstAt: d.ts },
                $set: { lastTicker: d.ticker, lastRound: d.roundLabel },
              },
              upsert: true,
            },
          })),
          { ordered: false }
        )
      }

      await rounds.updateOne(
        { roundId },
        {
          $set: {
            roundId,
            label: round?.label ?? null,
            startedAt: round?.startedAt ?? null,
            ticker,
            name,
            usdPerUnit: usdPerUnit ?? null,
            paid: true,
            reason: null,
            recipients: items.length,
            totalAmount: items.reduce((a, i) => a + i.amount, 0),
            totalUsd: usdPerUnit ? items.reduce((a, i) => a + i.amount, 0) * usdPerUnit : null,
            buy: buy ?? null,
            dryRun: !!dryRun,
            demo: !!demo,
            ts,
          },
        },
        { upsert: true }
      )
      console.info(`[db] stored ${inserted.length} payout(s) for round ${round?.label ?? roundId}`)
    } catch (e) {
      console.error('[db] recordDistribution:', e.message)
    }
  }

  /**
   * A round that did not pay, and why.
   *
   * Only successful distributions were being written, so a round that failed —
   * an empty pot, a stock with no pool — left no trace at all. Someone looking
   * at the history saw rounds happening on screen and nothing recorded, with no
   * way to tell "nobody has been paid yet" apart from "the recorder is broken".
   * A round is a fact whether or not money moved.
   */
  async function recordUnpaidRound({ round, ticker, name, reason }) {
    if (!ready) return
    const roundId = round?.id ?? Math.floor(Date.now() / 300_000)
    try {
      await rounds.updateOne(
        { roundId },
        {
          $set: {
            roundId,
            label: round?.label ?? null,
            startedAt: round?.startedAt ?? null,
            ticker,
            name: name ?? null,
            paid: false,
            reason,
            recipients: 0,
            totalAmount: 0,
            totalUsd: 0,
            ts: Date.now(),
          },
        },
        { upsert: true }
      )
    } catch (e) {
      console.error('[db] recordUnpaidRound:', e.message)
    }
  }

  /** The leaderboard: who has taken the most out of this game, in dollars. */
  async function leaderboard(limit = 100) {
    if (!ready) return { ready: false, rows: [], totals: null }
    const rows = await holders.find({}).sort({ totalUsd: -1 }).limit(Math.min(limit, 500)).toArray()
    const [totals] = await holders
      .aggregate([
        { $group: { _id: null, usd: { $sum: '$totalUsd' }, wallets: { $sum: 1 }, payouts: { $sum: '$payouts' } } },
      ])
      .toArray()
    return {
      ready: true,
      rows: rows.map((r, i) => ({
        rank: i + 1,
        address: r._id,
        totalUsd: r.totalUsd || 0,
        payouts: r.payouts || 0,
        byTicker: r.byTicker || {},
        lastTicker: r.lastTicker || null,
        lastRound: r.lastRound || null,
        lastAt: r.lastAt || null,
        lastHeldPct: r.lastHeldPct ?? null,
      })),
      totals: totals ? { usd: totals.usd || 0, wallets: totals.wallets || 0, payouts: totals.payouts || 0 } : null,
    }
  }

  /** One wallet's full history. */
  async function walletHistory(address, limit = 200) {
    if (!ready) return { ready: false, rows: [] }
    const to = String(address || '').toLowerCase()
    const rows = await payouts.find({ to }).sort({ ts: -1 }).limit(Math.min(limit, 500)).toArray()
    const doc = await holders.findOne({ _id: to })
    return { ready: true, address: to, summary: doc || null, rows }
  }

  /** Recent decided rounds. */
  async function roundHistory(limit = 50) {
    if (!ready) return { ready: false, rows: [] }
    return { ready: true, rows: await rounds.find({}).sort({ roundId: -1 }).limit(Math.min(limit, 200)).toArray() }
  }

  return {
    connect,
    recordDistribution,
    recordUnpaidRound,
    leaderboard,
    walletHistory,
    roundHistory,
    get ready() { return ready },
    get lastError() { return lastError },
    async close() { try { await client?.close() } catch {} },
  }
}
