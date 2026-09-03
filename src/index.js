// ============================================================================
// index.js — wiring. tape (Finnhub or sim) -> game -> hub -> browsers.
// ============================================================================

import { config } from './config.js'
import { createGame } from './game.js'
import { createHub } from './hub.js'
import { createFinnhubFeed } from './finnhub.js'
import { createSimFeed } from './simFeed.js'
import { createDistributor } from './distributor.js'
import { createDb } from './db.js'

let hub = null
let distributor = null

const game = createGame({
  onEvent: (e) => {
    hub?.broadcast(e)
    // The bell is also the payout trigger: the winner's stock gets bought and
    // airdropped to the memecoin's holders. Fire-and-forget — the game's clock
    // must never wait on a chain.
    if (e.type === 'roundEnd' && e.winner) {
      distributor?.onRoundWinner(e.winner, e.round)
    }
  },
})

const db = createDb(config.mongoUrl)
await db.connect()

hub = createHub({ port: config.port, game, db })
distributor = createDistributor({ onEvent: (e) => hub.broadcast(e), db })
hub.attachDistributor(distributor)

const feed = config.sim
  ? createSimFeed({ onTrade: game.onTrade })
  : createFinnhubFeed({ onTrade: game.onTrade, onStatus: () => {} })

feed.start()
game.start()
distributor.start()

console.info(
  `[index] Stock Royale ready — ${config.roundMs / 60000}-minute rounds, ` +
    `${config.sim ? 'SYNTHETIC tape' : 'live tape via Finnhub'}, session ${game.session.label}.`
)

function shutdown() {
  console.info('\n[index] shutting down')
  feed.stop()
  game.stop()
  distributor.stop()
  hub.close()
  db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
