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

  /**
   * The prize. When a round ends, the pot wallet buys the winning ticker's
   * tokenized stock on Robinhood Chain and airdrops it to the holders of the
   * game's memecoin. Off by default, and DRY_RUN on by default even when armed:
   * nothing touches real funds until both switches are thrown deliberately.
   */
  chain: {
    airdrop: process.env.AIRDROP === '1',
    dryRun: String(process.env.DRY_RUN ?? 'true') === 'true',
    rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
    chainId: Number(process.env.CHAIN_ID || 4663),
    /**
     * The Pro API host, NOT the public explorer. The public instance
     * (robinhoodchain.blockscout.com) sits behind a Cloudflare challenge and
     * answers any server 403 with an HTML "Just a moment…" page — which reads
     * downstream as "this token has no holders". This host answers 402 without
     * a key, which at least says what is wrong.
     */
    blockscout: (process.env.BLOCKSCOUT_URL || 'https://api.blockscout.com/4663').replace(/\/$/, ''),
    blockscoutPublic: (process.env.BLOCKSCOUT_PUBLIC || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),
    blockscoutKey: process.env.BLOCKSCOUT_API_KEY || '',
    explorer: (process.env.EXPLORER_URL || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),
    /** The memecoin whose holders receive the winning stock. */
    token: (process.env.TOKEN || '').trim().toLowerCase(),
    privateKey: process.env.DISTRIBUTOR_PRIVATE_KEY || '',
    weth: (process.env.WETH || '0x0bd7d308f8e1639fab988df18a8011f41eacad73').toLowerCase(),
    router: (process.env.SWAP_ROUTER || '0xCb0615a1478838DeA20E57447309be97f45DcA0f').toLowerCase(),
    poolDeployer: process.env.POOL_DEPLOYER || '0x0000000000000000000000000000000000000000',
    buyPct: Number(process.env.BUY_PCT || 80),
    slippagePct: Number(process.env.BUY_SLIPPAGE_PCT || 20), // thin Algebra pools
    leaveWei: BigInt(Math.round(Number(process.env.LEAVE_ETH ?? 0.003) * 1e18)),
    minPct: Number(process.env.MIN_ELIGIBLE_PCT || 0.1),
    maxPct: Number(process.env.MAX_HOLDER_PCT || 50),
    excludeContracts: String(process.env.EXCLUDE_CONTRACTS ?? 'true') === 'true',

    /**
     * ---- POOL / CURVE DETECTION ----
     * The part that has actually gone wrong before, so it is worth being
     * explicit about. On a launchpad token (Pons and friends) the BONDING CURVE
     * contract holds most of the supply, and after graduation the AMM pool does.
     * Neither is a holder. Miss one and it collects the biggest slice of every
     * airdrop, which is money set on fire.
     *
     * Any CONTRACT holding at least poolMinPct of supply is treated as a pool.
     * That rule catches curves and pools whose addresses nobody knew in advance,
     * which is the only rule that survives a launchpad shipping a v2.
     */
    poolMinPct: Number(process.env.POOL_MIN_PCT || 0.5),
    /**
     * Known infrastructure addresses, checked straight off the chain with
     * balanceOf so detection doesn't depend on the indexer being up or on it
     * having flagged them as contracts. The first is Robinhood Chain's Uniswap
     * v4 singleton PoolManager — ALL v4 liquidity lives in that one contract,
     * so it shows up as a single enormous "holder" on every v4 token.
     */
    poolCandidates: (
      process.env.POOL_CANDIDATES ||
      '0x8366a39cc670b4001a1121b8f6a443a643e40951,0x52d571fe77027298e06e52fc4434e1507f819268'
    ).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),

    /**
     * Re-read every eligible holder's balance from the chain before paying.
     * Blockscout is used to ENUMERATE addresses; the chain decides the amounts.
     * A stale or truncated index then costs an address its place in the list,
     * never the wrong number of shares.
     */
    verifyOnchain: String(process.env.VERIFY_ONCHAIN ?? 'true') === 'true',
    verifyMax: Number(process.env.VERIFY_MAX || 400),
    /**
     * Reconstruct holders from Transfer logs over the RPC when the indexer is
     * unavailable. No API key, no third party — but it has to replay the
     * token's history, so it suits a young memecoin and not a heavily traded
     * one. Set chainStartBlock to the token's first block to make it cheap.
     */
    chainFallback: String(process.env.CHAIN_FALLBACK ?? 'true') === 'true',
    chainStartBlock: process.env.TOKEN_START_BLOCK ? Number(process.env.TOKEN_START_BLOCK) : null,
    chainMaxCalls: Number(process.env.CHAIN_MAX_CALLS || 400),
    /** Budgets for the /holders?token= probe, which answers an HTTP request. */
    probeMaxCalls: Number(process.env.PROBE_MAX_CALLS || 150),
    probeLookback: Number(process.env.PROBE_LOOKBACK || 400_000), // ~11 hours of blocks
    probeTimeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 45_000),
    /** Refuse to pay if the crawl accounts for less than this % of supply. */
    minSupplyCoverage: Number(process.env.MIN_SUPPLY_COVERAGE || 40),
    /**
     * How much of the supply must be ACCOUNTED FOR before the holder search is
     * allowed to stop. This is not the same number as minSupplyCoverage and it
     * has to be high: unaccounted supply is not "a bit of noise", it is supply
     * sitting in wallets nobody has looked at yet, any one of which can be
     * larger than every wallet found so far. Stopping at 83% once hid the
     * holder who was owed 89% of the airdrop.
     */
    discoveryTarget: Number(process.env.DISCOVERY_TARGET || 99.5),
    exclude: new Set(
      (process.env.EXCLUDE_ADDRESSES || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
    ),
    payoutGas: BigInt(process.env.PAYOUT_GAS_LIMIT || 800_000),
    sendDelayMs: Number(process.env.SEND_DELAY_MS || 250),
    holdersPollMs: Number(process.env.HOLDERS_POLL_MS || 60_000),
    holdersStaleMs: Number(process.env.HOLDERS_STALE_MS || 10 * 60_000),
    /**
     * Dev only: synthesize this many holders so the airdrop panel can be built
     * and reviewed before a real memecoin exists. Every event it produces is
     * stamped demo:true and the frontend labels it — it must never be mistaken
     * for a payout that happened.
     */
    demoHolders: Number(process.env.DEMO_HOLDERS || 0),
  },

  /** Durable store for every payout ever made. Optional; the game runs without it. */
  mongoUrl:
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    process.env.MONGO_PUBLIC_URL ||
    process.env.DATABASE_URL ||
    '',
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

/** Absolute floors: a print has to be worth real money to ever be a block. */
export const FLOOR = Object.freeze({
  fish: Number(process.env.F_FISH || 4_000),
  dolphin: Number(process.env.F_DOLPHIN || 20_000),
  whale: Number(process.env.F_WHALE || 45_000),
})

/** Percentile cutoffs, as a fraction of a symbol's own recent prints. */
export const PCTL = Object.freeze({
  fish: Number(process.env.P_FISH || 0.7),
  dolphin: Number(process.env.P_DOLPHIN || 0.94),
  whale: Number(process.env.P_WHALE || 0.99),
})

export function classifyAbsolute(notional) {
  if (notional >= THRESH.whale) return 'whale'
  if (notional >= THRESH.dolphin) return 'dolphin'
  if (notional >= THRESH.fish) return 'fish'
  return 'shrimp'
}

const RANK = { shrimp: 0, fish: 1, dolphin: 2, whale: 3 }
const NAME = ['shrimp', 'fish', 'dolphin', 'whale']

/**
 * A print's size class, judged BOTH ways and given the better of the two.
 *
 * Fixed dollar thresholds alone don't survive the day: at the open a $50K print
 * is unremarkable, and after 16:00 ET the whole tape thins out until nothing
 * clears any bar and the battlefield goes quiet for minutes. So a print is also
 * measured against that symbol's OWN recent prints — top 1% is a whale wherever
 * the session is — with the absolute floors making sure a big fish in an empty
 * pond is still a fish.
 */
export function classify(notional, percentile = null) {
  let r = RANK[classifyAbsolute(notional)]
  if (percentile != null) {
    let pr = 0
    if (percentile >= PCTL.whale && notional >= FLOOR.whale) pr = 3
    else if (percentile >= PCTL.dolphin && notional >= FLOOR.dolphin) pr = 2
    else if (percentile >= PCTL.fish && notional >= FLOOR.fish) pr = 1
    if (pr > r) r = pr
  }
  return NAME[r]
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
