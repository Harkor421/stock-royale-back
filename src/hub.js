// ============================================================================
// hub.js — one WebSocket server, one shared game. Unlike The Trenches (where
// each client picked its own coin), Stock Royale is a single global match:
// everybody watches the same 8 armies and the same round clock, so the hub is
// a plain fan-out broadcaster.
//
//   client connects      -> gets a `hello` snapshot (roster, round, standings)
//   client -> {op:'ping'} -> {type:'pong'}   keepalive
//
// HTTP on the same port answers the health check and exposes the state as JSON
// for anything that isn't a browser (bots, overlays, the winner webhook).
// ============================================================================

import http from 'http'
import { WebSocketServer } from 'ws'

export function createHub({ port, game, db }) {
  const clients = new Set()
  let distributor = null

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const json = (body) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/state') {
      return json({ ...game.snapshot(), airdrop: distributor?.snapshot() ?? null })
    }
    if (url.pathname === '/history') return json({ history: game.history })

    // --- the public record: who has been paid what, ever ---
    if (url.pathname === '/leaderboard') {
      return db
        .leaderboard(Number(url.searchParams.get('limit') || 100))
        .then(json)
        .catch((e) => json({ ready: false, rows: [], error: e.message }))
    }
    if (url.pathname === '/rounds') {
      return db
        .roundHistory(Number(url.searchParams.get('limit') || 50))
        .then(json)
        .catch((e) => json({ ready: false, rows: [], error: e.message }))
    }
    if (url.pathname.startsWith('/wallet/')) {
      return db
        .walletHistory(decodeURIComponent(url.pathname.slice('/wallet/'.length)))
        .then(json)
        .catch((e) => json({ ready: false, rows: [], error: e.message }))
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
    res.end(
      `Stock Royale backend — ${clients.size} viewer(s), ${game.session.label}.\n` +
        'Connect a WebSocket to this same URL for the live event stream.\n' +
        'JSON: /state · /history · /leaderboard · /rounds · /wallet/<address>\n' +
        `Persistence: ${db?.ready ? 'on' : 'off'}\n`
    )
  })

  const wss = new WebSocketServer({ server })

  wss.on('connection', (client) => {
    clients.add(client)
    try {
      client.send(JSON.stringify({ ...game.snapshot(), airdrop: distributor?.snapshot() ?? null }))
    } catch {}
    client.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.op === 'ping') {
        try { client.send(JSON.stringify({ type: 'pong', ts: Date.now() })) } catch {}
      }
    })
    client.on('close', () => clients.delete(client))
    client.on('error', () => clients.delete(client))
  })

  function broadcast(event) {
    if (clients.size === 0) return
    const data = JSON.stringify(event)
    for (const c of clients) {
      if (c.readyState === 1) {
        try { c.send(data) } catch {}
      }
    }
  }

  server.listen(port, () => console.info(`[hub] Stock Royale backend listening on :${port}`))

  return {
    broadcast,
    attachDistributor(d) {
      distributor = d
    },
    get viewers() {
      return clients.size
    },
    close() {
      for (const c of clients) { try { c.close() } catch {} }
      wss.close()
      server.close()
    },
  }
}
