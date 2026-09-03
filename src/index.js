// ============================================================================
// index.js — wiring. tape (Finnhub or sim) -> game -> hub -> browsers.
// ============================================================================

import { config } from './config.js'
import { createGame } from './game.js'
import { createHub } from './hub.js'
import { createFinnhubFeed } from './finnhub.js'
import { createSimFeed } from './simFeed.js'

let hub = null
const game = createGame({ onEvent: (e) => hub?.broadcast(e) })
hub = createHub({ port: config.port, game })

const feed = config.sim
  ? createSimFeed({ onTrade: game.onTrade })
  : createFinnhubFeed({ onTrade: game.onTrade, onStatus: () => {} })

feed.start()
game.start()

console.info(
  `[index] Stock Royale ready — ${config.roundMs / 60000}-minute rounds, ` +
    `${config.sim ? 'SYNTHETIC tape' : 'live tape via Finnhub'}, session ${game.session.label}.`
)

function shutdown() {
  console.info('\n[index] shutting down')
  feed.stop()
  game.stop()
  hub.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
