// ============================================================================
// distributor.js — the prize.
//
// When a round ends, the pot wallet BUYS the winning ticker's tokenized stock
// on Robinhood Chain and airdrops it, pro-rata, to the holders of the game's
// memecoin. Same machinery as Flip The World, retargeted: there the trigger was
// a market-cap milestone, here it is the five-minute bell.
//
//   roundEnd(winner) ──▶ buy WETH→stock (Algebra exactInputSingle)
//                   └──▶ ERC-20 transfer to every eligible holder, pro-rata
//
// Everything it does is streamed out as events so the frontend can put the
// recipient list on screen with a link to each transaction.
//
// ⚠ DRY_RUN defaults to TRUE. Nothing touches real funds until it is explicitly
//   turned off AND a distributor key and memecoin address are configured.
// ============================================================================

import { ethers } from 'ethers'
import { config, TICKERS } from './config.js'
import { createChainHolders } from './chainHolders.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()
const isAddr = (a) => typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a)
const fmtUnits = (raw, dec) => Number(ethers.formatUnits(raw ?? 0n, dec ?? 18))

const ZERO = '0x0000000000000000000000000000000000000000'
const DEAD = '0x000000000000000000000000000000000000dead'

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]
const WETH_ABI = [...ERC20_ABI, 'function deposit() payable']
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,address deployer,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 limitSqrtPrice)) payable returns (uint256)',
]

/**
 * The tokenized stocks on Robinhood Chain. Every ticker in the game's roster
 * has one — that is why the roster is what it is.
 */
export const STOCK_TOKENS = Object.freeze({
  AAPL: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  AMD: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC',
  AMZN: '0x12f190a9F9d7D37a250758b26824B97CE941bF54',
  GOOGL: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3',
  META: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35',
  MSFT: '0xe93237C50D904957Cf27E7B1133b510C669c2e74',
  NVDA: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  TSLA: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
})

export function createDistributor({ onEvent, db }) {
  const c = config.chain
  const enabled = c.airdrop
  const provider = c.rpcUrl ? new ethers.JsonRpcProvider(c.rpcUrl, c.chainId) : null
  const wallet = c.privateKey && provider ? new ethers.Wallet(c.privateKey, provider) : null
  const chain = provider ? createChainHolders({ provider, chainId: c.chainId }) : null
  const dryRun = c.dryRun || !wallet || !isAddr(c.token)

  const stockDecimals = new Map()
  let tokenDecimals = 18
  let tokenSymbol = null
  let tokenTotalSupply = 0n
  let holders = null // { ts, rows:[{address, raw, amount, pct}] }
  let contractHolders = new Set()
  let poolSet = new Set() //   curves + AMM pools: never paid, always reported
  let rpcPools = new Set() //  known infrastructure confirmed straight off-chain
  let lastEligibleCount = 0
  let diagnostics = null
  let wethApproved = false
  let busy = false
  let holdersTimer = null
  let potTimer = null

  const emit = (e) => onEvent({ ...e, ts: e.ts ?? now() })
  const bsAuth = () => (c.blockscoutKey ? { apikey: c.blockscoutKey } : {})
  const explorerTx = (hash) => `${c.explorer}/tx/${hash}`
  const explorerAddr = (a) => `${c.explorer}/address/${a}`

  // -- Blockscout --------------------------------------------------------

  // Blockscout's public instance sits behind a WAF that answers 403 to requests
  // with no User-Agent — which is what bare fetch() sends. Found the hard way:
  // holder detection simply returned nothing, with no error that pointed at the
  // cause. Identify ourselves on every call.
  const HTTP_HEADERS = {
    'user-agent': 'stock-royale/1.0 (+https://github.com/Harkor421/stock-royale-back)',
    accept: 'application/json',
  }

  async function getJson(base, path, params) {
    const url = new URL(base + path)
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null) url.searchParams.set(k, String(v))
    }
    const r = await fetch(url, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new Error(`${path} -> ${r.status}`)
    return r.json()
  }

  /**
   * One complete crawl of the memecoin's holders. Built into local structures
   * and only applied whole: a crawl that dies half way is thrown away, never
   * distributed over, or the last page of holders would silently get nothing.
   */
  async function crawlHolders(base, useAuth, token = c.token) {
    const map = new Map()
    const contracts = new Set()
    let params = useAuth ? { ...bsAuth() } : {}
    for (let page = 0; page < 500; page++) {
      let data = null
      for (let tries = 0; tries < 5; tries++) {
        try {
          data = await getJson(base, `/api/v2/tokens/${token}/holders`, params)
          break
        } catch (e) {
          if (tries === 4) throw e
          await sleep(1000 * (tries + 1)) // 429 / 5xx backoff
        }
      }
      const items = data?.items || []
      for (const it of items) {
        const addr = (it.address?.hash || it.address_hash || '').toLowerCase()
        const val = it.value ?? it.balance
        if (addr && val != null) map.set(addr, BigInt(val))
        if (addr && it.address?.is_contract) contracts.add(addr)
      }
      const npp = data?.next_page_params
      if (!npp || !items.length) break
      params = useAuth ? { ...npp, ...bsAuth() } : { ...npp }
    }
    return { map, contracts }
  }

  async function loadTokenMeta() {
    try {
      const d = await getJson(c.blockscout, `/api/v2/tokens/${c.token}`, bsAuth())
      if (d?.decimals != null) tokenDecimals = Number(d.decimals)
      if (d?.symbol) tokenSymbol = d.symbol
      if (d?.total_supply != null) tokenTotalSupply = BigInt(d.total_supply)
      if (tokenTotalSupply > 0n && tokenSymbol) return
    } catch {}
    if (!provider) return
    const t = new ethers.Contract(c.token, ERC20_ABI, provider)
    try { tokenDecimals = Number(await t.decimals()) } catch {}
    try { tokenTotalSupply = await t.totalSupply() } catch {}
    // The UI names the coin everywhere it explains the airdrop. Read the symbol
    // off the contract rather than hard-coding it, so the copy can't outlive a
    // change of token.
    try { tokenSymbol = await t.symbol() } catch {}
  }

  /**
   * Pools and bonding curves, found by the only rule that keeps working when a
   * launchpad ships a new version: a CONTRACT sitting on a big share of supply
   * is infrastructure, not a holder. Union of three sources, so no single one
   * being wrong or down can let a curve through and hand it the biggest slice
   * of an airdrop:
   *   · contract holders over poolMinPct, from the indexer
   *   · the single largest contract holder, whatever its size
   *   · known addresses re-checked straight off the chain
   */
  function refreshPools(balances) {
    const next = new Set(rpcPools)
    if (tokenTotalSupply > 0n) {
      const minRaw = (tokenTotalSupply * BigInt(Math.round(c.poolMinPct * 1000))) / 100_000n
      let biggest = null
      let biggestBal = 0n
      for (const a of contractHolders) {
        const b = balances.get(a) || 0n
        if (b >= minRaw) next.add(a)
        if (b > biggestBal) {
          biggestBal = b
          biggest = a
        }
      }
      if (biggest) next.add(biggest)
    }
    poolSet = next
    return poolSet
  }

  /** Confirm the known infrastructure addresses against the chain itself, so
   *  pool detection survives the indexer being down or mislabelling them. */
  async function refreshRpcPools() {
    if (!provider || !isAddr(c.token) || !c.poolCandidates.length) return
    try {
      if (tokenTotalSupply === 0n) await loadTokenMeta()
      if (tokenTotalSupply === 0n) return
      const minRaw = (tokenTotalSupply * BigInt(Math.round(c.poolMinPct * 1000))) / 100_000n
      const token = new ethers.Contract(c.token, ERC20_ABI, provider)
      for (const a of c.poolCandidates) {
        try {
          const b = await token.balanceOf(a)
          if (b >= minRaw) rpcPools.add(a)
          else rpcPools.delete(a)
        } catch {}
      }
    } catch (e) {
      console.warn('[airdrop] pool candidates:', e.message)
    }
  }

  const isExcluded = (addr) =>
    addr === ZERO ||
    addr === DEAD ||
    addr === wallet?.address?.toLowerCase() ||
    c.exclude.has(addr) ||
    poolSet.has(addr) ||
    (c.excludeContracts && contractHolders.has(addr))

  /**
   * Re-read balances from the chain for the addresses about to be paid. The
   * indexer decides WHO is in the list; the chain decides HOW MUCH. A lagging
   * or truncated index then costs someone their place in the list, and never
   * costs anyone the wrong number of shares.
   */
  async function verifyBalances(rows) {
    if (!c.verifyOnchain || !provider || !rows.length) return rows
    const take = rows.slice(0, c.verifyMax)
    const token = new ethers.Contract(c.token, ERC20_ABI, provider)
    const CONC = 8
    let drift = 0
    for (let i = 0; i < take.length; i += CONC) {
      await Promise.all(
        take.slice(i, i + CONC).map(async (r) => {
          try {
            const onchain = await token.balanceOf(r.address)
            if (onchain !== r.raw) {
              drift++
              r.indexed = r.raw
              r.raw = onchain
              r.amount = fmtUnits(onchain, tokenDecimals)
              r.pct = holdersSupply > 0 ? (r.amount / holdersSupply) * 100 : r.pct
            }
          } catch {
            /* one RPC miss must not drop a holder — keep the indexed value */
          }
        })
      )
    }
    if (drift) console.info(`[airdrop] ${drift}/${take.length} balances corrected against the chain`)
    return rows
  }

  let holdersSupply = 0
  let holdersSource = null

  /**
   * Get the holder set, from whichever source can actually answer.
   *
   *   1. Blockscout Pro (needs BLOCKSCOUT_API_KEY)
   *   2. the public explorer — usually Cloudflare-blocked to servers, kept
   *      because it works from some networks
   *   3. the chain itself, replaying Transfer logs (no key, no indexer)
   *
   * Every failure is reported with the reason, because the way this breaks is
   * by looking like a token with no holders.
   */
  async function fetchHolders(token = c.token, supplyRaw = tokenTotalSupply, budget = null) {
    const tried = []
    for (const [base, auth, label] of [
      [c.blockscout, true, 'blockscout-pro'],
      [c.blockscoutPublic, false, 'blockscout-public'],
    ]) {
      if (!base) continue
      try {
        const res = await crawlHolders(base, auth, token)
        if (res.map.size) {
          holdersSource = label
          return { ...res, source: label }
        }
        tried.push(`${label}: returned no holders`)
      } catch (e) {
        const msg = String(e.message || e)
        tried.push(
          `${label}: ${msg}` +
            (msg.includes('403') ? ' (Cloudflare challenge — this host blocks servers)' : '') +
            (msg.includes('402') ? ' (needs BLOCKSCOUT_API_KEY)' : '')
        )
      }
    }

    if (c.chainFallback && chain) {
      console.warn(`[airdrop] indexers unavailable (${tried.join(' · ')}) — rebuilding holders from Transfer logs`)
      // Ask the chain what each address holds NOW, rather than replaying every
      // transfer the token has ever made. The logs are only used to discover
      // which addresses to ask about, so this converges in seconds regardless
      // of how old the coin is.
      const built = await chain.currentBalances(token, {
        totalSupply: supplyRaw,
        targetCoverage: c.discoveryTarget / 100,
        deadline: budget?.deadline ?? Date.now() + 120_000,
      })
      // Never pay over a partial holder set. The supply not accounted for is
      // not noise — it is wallets nobody has looked at, and one of them can be
      // bigger than everything found so far.
      if (!built.complete) {
        throw new Error(
          `only accounted for ${built.coveragePct.toFixed(1)}% of supply (need ${c.discoveryTarget}%) after searching back to ` +
            `block ${built.scannedFrom}. The rest sits in wallets that have not moved recently, and any one of them could be ` +
            `owed more than everyone found so far. Widen the search or set BLOCKSCOUT_API_KEY to read holders from the indexer.`
        )
      }
      const contracts = await chain.contractsAmong(
        // only the addresses big enough to be pools need the code check
        [...built.map.entries()]
          .filter(([, v]) => supplyRaw > 0n && (v * 10000n) / supplyRaw >= BigInt(Math.round(c.poolMinPct * 100)))
          .map(([a]) => a)
      )
      holdersSource = 'rpc-transfer-logs'
      return {
        map: built.map,
        contracts,
        source: 'rpc-balanceof',
        partial: !built.complete,
        scannedFrom: built.scannedFrom,
        scannedTo: built.scannedTo,
      }
    }

    throw new Error(`no holder source available — ${tried.join(' · ')}`)
  }

  /** A stand-in holder set for building the UI before a real token exists. */
  function demoHolders() {
    const rows = []
    let seed = 987654321
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    let total = 0
    for (let i = 0; i < c.demoHolders; i++) {
      const weight = Math.pow(rnd(), 2.2) * 100 + 0.2 // a realistic long tail
      total += weight
      let addr = '0x'
      for (let k = 0; k < 40; k++) addr += '0123456789abcdef'[(rnd() * 16) | 0]
      rows.push({ address: addr, weight })
    }
    rows.sort((a, b) => b.weight - a.weight)
    return rows.map((r, i) => ({
      address: r.address,
      raw: BigInt(Math.round(r.weight * 1e9)),
      amount: r.weight * 1e6,
      pct: (r.weight / total) * 100,
      rank: i + 1,
    }))
  }

  /** Refresh the eligible-holder snapshot the next airdrop will pay out over. */
  async function pollHolders() {
    if (!isAddr(c.token)) {
      if (c.demoHolders > 0) {
        const rows = demoHolders()
        holders = { ts: now(), rows, supply: 1e9, total: rows.length, demo: true }
        console.warn(`[airdrop] DEMO holder set (${rows.length}) — no TOKEN configured, nothing is real`)
      }
      return
    }
    try {
      if (tokenTotalSupply === 0n) await loadTokenMeta()
      const res = await fetchHolders()
      contractHolders = res.contracts
      await refreshRpcPools()
      refreshPools(res.map)

      const supply = fmtUnits(tokenTotalSupply, tokenDecimals)
      holdersSupply = supply
      let crawled = 0n
      let inPools = 0n
      const rows = []
      for (const [address, raw] of res.map) {
        crawled += raw
        if (poolSet.has(address)) inPools += raw
        if (raw <= 0n || isExcluded(address)) continue
        const amount = fmtUnits(raw, tokenDecimals)
        const pct = supply > 0 ? (amount / supply) * 100 : 0
        if (pct < c.minPct || pct > c.maxPct) continue
        rows.push({ address, raw, amount, pct })
      }

      // A crawl that only saw a sliver of the supply is a TRUNCATED crawl, not
      // a token with a tiny float. Paying over it would hand the whole airdrop
      // to whichever addresses happened to land on the first page.
      const coverage = tokenTotalSupply > 0n ? Number((crawled * 10000n) / tokenTotalSupply) / 100 : 0
      if (coverage < c.minSupplyCoverage) {
        diagnostics = { ts: now(), token: c.token, coveragePct: coverage, rejected: 'crawl covers too little of the supply' }
        console.warn(
          `[airdrop] crawl covers only ${coverage.toFixed(1)}% of supply (need ${c.minSupplyCoverage}%) — snapshot rejected`
        )
        return
      }

      await verifyBalances(rows)
      const onlyWallets = await keepOnlyWallets(rows)
      if (onlyWallets.removed.length) {
        console.info(`[airdrop] ${onlyWallets.removed.length} contract(s) dropped from the payout list`)
      }
      const live = onlyWallets.rows.filter((r) => r.raw > 0n && r.pct >= c.minPct && r.pct <= c.maxPct)
      live.sort((a, b) => b.amount - a.amount)
      live.forEach((r, i) => (r.rank = i + 1))

      // A collapse in the holder count is an indexer problem far more often
      // than a real exodus, and paying over it silently concentrates the
      // airdrop into whichever addresses survived the bad crawl.
      if (lastEligibleCount > 20 && live.length < lastEligibleCount * 0.3) {
        diagnostics = { ts: now(), token: c.token, rejected: 'eligible holders collapsed vs the previous crawl', was: lastEligibleCount, now: live.length }
        console.warn(
          `[airdrop] eligible holders fell ${lastEligibleCount} -> ${live.length} — snapshot rejected as a likely bad crawl`
        )
        return
      }
      lastEligibleCount = live.length

      holders = { ts: now(), rows: live, supply, total: res.map.size }
      const poolPct = supply > 0 ? (fmtUnits(inPools, tokenDecimals) / supply) * 100 : 0
      diagnostics = {
        ts: now(),
        token: c.token,
        totalSupply: supply,
        source: holdersSource,
        addressesSeen: res.map.size,
        coveragePct: coverage,
        contractsFlagged: contractHolders.size,
        heldByPoolsPct: poolPct,
        pools: [...poolSet].map((a) => ({
          address: a,
          balance: fmtUnits(res.map.get(a) || 0n, tokenDecimals),
          pctOfSupply: supply > 0 ? (fmtUnits(res.map.get(a) || 0n, tokenDecimals) / supply) * 100 : 0,
          confirmedOnchain: rpcPools.has(a),
          flaggedContract: contractHolders.has(a),
        })),
        eligible: live.length,
        eligibleSupplyPct: live.reduce((a, r) => a + r.pct, 0),
        top: live.slice(0, 10).map((r) => ({ address: r.address, amount: r.amount, pct: r.pct })),
        settings: {
          onchainVerified: c.verifyOnchain,
          minEligiblePct: c.minPct,
          maxHolderPct: c.maxPct,
          poolMinPct: c.poolMinPct,
          minSupplyCoverage: c.minSupplyCoverage,
        },
      }
      console.info(
        `[airdrop] via ${holdersSource}: ${live.length} eligible holders of ${c.token} · ${poolSet.size} pool/curve excluded ` +
          `(${poolPct.toFixed(1)}% of supply) · crawl covered ${coverage.toFixed(1)}%`
      )
    } catch (e) {
      console.error('[airdrop] holders poll:', e.message)
    }
  }

  /**
   * Every address about to be paid gets eth_getCode run on it.
   *
   * The pool rules catch infrastructure by SIZE — a contract sitting on a big
   * share of supply. That leaves a gap: a router, a vault, a bridge or a
   * multisig holding a modest share is not a pool by that rule and is not a
   * person either. And on the indexer path the is_contract flag can simply be
   * missing.
   *
   * So the last word on "is this a real wallet" comes from the chain, for every
   * recipient, not just the big ones. It costs one call per address on a list
   * that is usually small, and it is the difference between paying people and
   * paying contracts.
   */
  async function keepOnlyWallets(rows) {
    if (!provider || !chain || !rows.length) return { rows, removed: [] }
    const code = await chain.contractsAmong(rows.map((r) => r.address))
    if (!code.size) return { rows, removed: [] }
    const removed = rows.filter((r) => code.has(r.address))
    for (const r of removed) r.why = 'contract (verified on-chain)'
    return { rows: rows.filter((r) => !code.has(r.address)), removed }
  }

  /**
   * Analyse ANY token's holders without touching the live snapshot — point it
   * at a launchpad address and it reports what it found and, more importantly,
   * WHY each address was excluded. Holder detection is the part of this that
   * has gone wrong before; this is how you see it going wrong.
   */
  async function probe(tokenAddress, opts = {}) {
    const token = String(tokenAddress || '').trim().toLowerCase()
    if (!isAddr(token)) throw new Error('not an EVM address')

    let decimals = 18
    let supplyRaw = 0n
    try {
      const meta = await getJson(c.blockscout, `/api/v2/tokens/${token}`, bsAuth())
      if (meta?.decimals != null) decimals = Number(meta.decimals)
      if (meta?.total_supply != null) supplyRaw = BigInt(meta.total_supply)
    } catch {}
    if (supplyRaw === 0n && provider) {
      const t = new ethers.Contract(token, ERC20_ABI, provider)
      try { decimals = Number(await t.decimals()) } catch {}
      try { supplyRaw = await t.totalSupply() } catch {}
    }
    if (supplyRaw === 0n) throw new Error('could not read total supply — wrong chain or wrong address?')

    // whichever source can answer — indexer, or the chain itself
    // `from` is the difference between a useful probe and a timeout on a busy
    // token: given the block the token launched at, the scan is bounded and
    // fast; without it, finding the start of history eats the whole budget.
    const res = await fetchHolders(token, supplyRaw, {
      maxCalls: Number(opts.maxCalls) || c.probeMaxCalls,
      lookback: c.probeLookback,
      startBlock: opts.startBlock != null ? Number(opts.startBlock) : undefined,
      deadline: Date.now() + (Number(opts.timeoutMs) || c.probeTimeoutMs),
    })

    const supply = fmtUnits(supplyRaw, decimals)
    const minRaw = (supplyRaw * BigInt(Math.round(c.poolMinPct * 1000))) / 100_000n
    const pools = new Set()
    let biggest = null
    let biggestBal = 0n
    for (const a of res.contracts) {
      const b = res.map.get(a) || 0n
      if (b >= minRaw) pools.add(a)
      if (b > biggestBal) { biggestBal = b; biggest = a }
    }
    if (biggest) pools.add(biggest)
    if (provider) {
      const t = new ethers.Contract(token, ERC20_ABI, provider)
      for (const a of c.poolCandidates) {
        try { if ((await t.balanceOf(a)) >= minRaw) pools.add(a) } catch {}
      }
    }

    let crawled = 0n
    const eligible = []
    const excluded = []
    for (const [address, raw] of res.map) {
      crawled += raw
      const amount = fmtUnits(raw, decimals)
      const pct = supply > 0 ? (amount / supply) * 100 : 0
      let why = null
      if (raw <= 0n) why = 'zero balance'
      else if (address === ZERO || address === DEAD) why = 'burn address'
      else if (c.exclude.has(address)) why = 'on the exclude list'
      else if (pools.has(address)) why = 'pool or bonding curve'
      else if (c.excludeContracts && res.contracts.has(address)) why = 'contract'
      else if (pct < c.minPct) why = `below ${c.minPct}% of supply`
      else if (pct > c.maxPct) why = `above ${c.maxPct}% of supply`
      if (why) excluded.push({ address, amount, pct, why })
      else eligible.push({ address, amount, pct, raw })
    }
    // the chain has the last word on who is a person
    const verified = await keepOnlyWallets(eligible)
    for (const r of verified.removed) excluded.push(r)
    const wallets = verified.rows

    wallets.sort((a, b) => b.amount - a.amount)
    excluded.sort((a, b) => b.amount - a.amount)
    wallets.forEach((r, i) => (r.rank = i + 1))

    const coverage = supplyRaw > 0n ? Number((crawled * 10000n) / supplyRaw) / 100 : 0
    return {
      token,
      source: res.source,
      // a probe that ran out of budget saw only part of the history, and every
      // number below is therefore a floor, not a total
      partial: !!res.partial,
      partialHint: res.partial
        ? 'Only part of the history was scanned. Re-run with &from=<the block the token launched at> for a complete answer, or set BLOCKSCOUT_API_KEY to use the indexer.'
        : null,
      scannedFrom: res.scannedFrom ?? null,
      scannedTo: res.scannedTo ?? null,
      decimals,
      totalSupply: supply,
      addressesSeen: res.map.size,
      coveragePct: coverage,
      coverageOk: coverage >= c.minSupplyCoverage,
      contractsFlagged: res.contracts.size,
      pools: [...pools].map((a) => ({
        address: a,
        amount: fmtUnits(res.map.get(a) || 0n, decimals),
        pctOfSupply: supply > 0 ? (fmtUnits(res.map.get(a) || 0n, decimals) / supply) * 100 : 0,
        known: c.poolCandidates.includes(a),
        flaggedContract: res.contracts.has(a),
      })),
      eligible: {
        count: wallets.length,
        supplyPct: wallets.reduce((a, r) => a + r.pct, 0),
        contractsRejected: verified.removed.length,
        top: wallets.slice(0, 25).map(({ raw, ...r }) => r),
        // the full set, raw balances included, is what a simulated split needs
        all: opts.full ? wallets : undefined,
      },
      excluded: { count: excluded.length, top: excluded.slice(0, 25) },
      settings: {
        poolMinPct: c.poolMinPct,
        minEligiblePct: c.minPct,
        maxHolderPct: c.maxPct,
        minSupplyCoverage: c.minSupplyCoverage,
        excludeContracts: c.excludeContracts,
      },
    }
  }

  /**
   * A dress rehearsal of a whole round's airdrop, over the REAL holders of a
   * real coin.
   *
   * This is not a mock. It runs the same holder detection, the same pool and
   * bonding-curve exclusion, the same on-chain balance check and the same
   * pro-rata split that a live payout runs — everything except the transfers.
   * So what it prints is what would actually be sent, which is the only kind of
   * rehearsal worth having before pointing money at a token.
   *
   * It streams the same events a real distribution does, so the panel on screen
   * plays it exactly as it would play the real thing, marked as a simulation.
   */
  async function simulate({ token, ticker = 'NVDA', shares = 100, startBlock, hours, days, stream = true, maxCalls, timeoutMs } = {}) {
    if (!isAddr(token)) throw new Error('pass ?token=0x… — the coin whose holders should receive the airdrop')
    const dec = 18
    const t0 = now()

    // Nobody knows their coin's launch block off the top of their head, but
    // everybody knows roughly when it launched. Robinhood Chain runs at about
    // ten blocks a second; rounding that down scans slightly further back than
    // asked, which errs toward covering the whole history rather than missing
    // the start of it.
    let from = startBlock != null && startBlock !== '' ? Number(startBlock) : null
    const window = Number(days) > 0 ? Number(days) * 24 : Number(hours) > 0 ? Number(hours) : 0
    if (from == null && window > 0 && provider) {
      const head = await provider.getBlockNumber()
      from = Math.max(0, head - Math.ceil(window * 35_000))
    }

    const scan = await probe(token, {
      full: true,
      startBlock: from ?? undefined,
      maxCalls: Number(maxCalls) || Math.max(c.probeMaxCalls, 400),
      timeoutMs: Number(timeoutMs) || Math.max(c.probeTimeoutMs, 90_000),
    })

    // A rehearsal over a partial view of the token is worse than no rehearsal:
    // it produces a confident recipient list built from whoever happened to
    // trade inside the scanned window. Hold it to the SAME coverage floor a
    // live payout is held to, and say exactly how to fix it.
    if (!scan.coverageOk || scan.partial) {
      throw new Error(
        `the scan only accounted for ${scan.coveragePct.toFixed(1)}% of supply (a payout needs ${c.minSupplyCoverage}%), ` +
          `so this would rehearse the wrong recipients. Say how far back to look with &days=7 (or &hours=12, or ` +
          `&from=<launch block>) so the scan covers the coin's whole history, or set BLOCKSCOUT_API_KEY to read ` +
          `holders from the indexer instead.`
      )
    }

    const rows = scan.eligible.all || []
    if (!rows.length) throw new Error('nothing to distribute: no address clears the eligibility floor')

    // Identical arithmetic to the live path: integer maths on raw balances, so
    // the rehearsal cannot round differently from the real thing.
    const potRaw = ethers.parseUnits(String(shares), dec)
    const totalW = rows.reduce((a, r) => a + r.raw, 0n)
    const payouts = rows
      .map((r) => ({ ...r, raw_out: (potRaw * r.raw) / totalW }))
      .filter((p) => p.raw_out > 0n)

    const items = payouts.map((p) => ({
      to: p.address,
      rank: p.rank,
      pct: p.pct, //            share of the coin's supply this wallet holds
      held: p.amount, //        how many coins that is
      shareOfDrop: Number((p.raw_out * 1000000n) / potRaw) / 10000, // % of the airdrop
      amount: fmtUnits(p.raw_out, dec),
      addrUrl: explorerAddr(p.address),
    }))
    const dust = rows.length - payouts.length

    if (stream) {
      emit({
        type: 'airdropStart',
        simulated: true,
        ticker,
        holders: items.length,
        token,
        ts: now(),
      })
      for (const it of items.slice(0, 400)) {
        emit({ type: 'airdropPayment', simulated: true, ticker, ...it, tx: null, txUrl: null })
        if (stream) await sleep(25)
      }
      emit({
        type: 'airdropResult',
        simulated: true,
        ticker,
        count: items.length,
        totalSent: shares,
        ts: now(),
      })
    }

    return {
      simulated: true,
      note: 'Nothing was bought and nothing was sent. Same holder detection, same exclusions, same split as a live round.',
      coin: {
        token,
        source: scan.source,
        partial: scan.partial,
        partialHint: scan.partialHint,
        totalSupply: scan.totalSupply,
        addressesSeen: scan.addressesSeen,
        supplyCovered: scan.coveragePct,
        blocksScanned: scan.scannedFrom != null ? `${scan.scannedFrom} → ${scan.scannedTo}` : null,
      },
      excludedFromDrop: {
        poolsAndCurves: scan.pools,
        otherCount: scan.excluded.count - scan.pools.length,
        examples: scan.excluded.top.filter((e) => e.why !== 'pool or bonding curve').slice(0, 8),
      },
      distribution: {
        ticker,
        shares,
        recipients: items.length,
        contractsRejected: scan.eligible.contractsRejected ?? 0,
        allVerifiedEoa: true,
        roundedToDust: dust,
        heldBetweenThem: `${scan.eligible.supplyPct.toFixed(2)}% of supply`,
        biggestCut: items[0] ? `${items[0].shareOfDrop.toFixed(2)}% of the airdrop` : null,
        smallestCut: items.length ? `${items[items.length - 1].shareOfDrop.toFixed(4)}% of the airdrop` : null,
        recipientsList: items,
      },
      tookMs: now() - t0,
    }
  }

  // -- buy ---------------------------------------------------------------

  async function stockDec(address) {
    if (stockDecimals.has(address)) return stockDecimals.get(address)
    let d = 18
    try { d = Number(await new ethers.Contract(address, ERC20_ABI, provider).decimals()) } catch {}
    stockDecimals.set(address, d)
    return d
  }

  const fakeHash = () => `0xSIM${now().toString(16)}${Math.random().toString(16).slice(2, 10)}`

  // ---------------------------------------------------------------- the pot
  // What the game has to give away, in dollars. Everything downstream of this
  // is a number people are watching to decide whether to hold the coin, so it
  // is published continuously rather than only at the bell.
  let ethUsd = null
  let ethUsdAt = 0
  let pot = null

  async function fetchEthUsd() {
    if (c.ethUsdOverride) return c.ethUsdOverride
    if (ethUsd != null && now() - ethUsdAt < 10 * 60_000) return ethUsd
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {
        headers: HTTP_HEADERS,
        signal: AbortSignal.timeout(9000),
      })
      const j = await r.json()
      const p = Number(j?.ethereum?.usd)
      if (p > 0) {
        ethUsd = p
        ethUsdAt = now()
      }
    } catch {
      /* keep the last good price; a stale ETH quote is better than a blank pot */
    }
    return ethUsd
  }

  async function pollPot() {
    if (!provider || !wallet) {
      // With no wallet configured there is no pot. Say so rather than showing
      // a zero, which would read as "the pot is empty" instead of "unset".
      pot = { ready: false, reason: wallet ? 'no rpc' : 'no distributor wallet configured' }
      emit({ type: 'pot', ts: now(), ...pot })
      return
    }
    try {
      const [balWei, px] = await Promise.all([provider.getBalance(wallet.address), fetchEthUsd()])
      const spendable = balWei > c.leaveWei ? balWei - c.leaveWei : 0n
      const budget = (spendable * BigInt(Math.round(c.buyPct))) / 100n
      const eth = Number(fmtUnits(balWei, 18))
      const nextEth = Number(fmtUnits(budget, 18))
      pot = {
        ready: true,
        address: wallet.address,
        addrUrl: explorerAddr(wallet.address),
        eth,
        ethUsd: px ?? null,
        usd: px ? eth * px : null,
        nextDropEth: nextEth,
        nextDropUsd: px ? nextEth * px : null,
        buyPct: c.buyPct,
        gasReserveEth: Number(fmtUnits(c.leaveWei, 18)),
        dryRun,
      }
      emit({ type: 'pot', ts: now(), ...pot })
    } catch (e) {
      console.warn('[airdrop] pot:', e.message)
    }
  }

  /** Swap BUY_PCT% of the pot's spendable ETH into the winner's stock. */
  async function buyStock(ticker, address) {
    const dec = await stockDec(address).catch(() => 18)
    if (dryRun) {
      const amount = 1 + Math.random() * 4
      return { amount, eth: 0.01, tx: fakeHash(), dec, simulated: true }
    }
    const bal = await provider.getBalance(wallet.address)
    const spendable = bal > c.leaveWei ? bal - c.leaveWei : 0n
    const budget = (spendable * BigInt(Math.round(c.buyPct))) / 100n
    if (budget <= 0n) throw new Error('pot has no ETH to buy with')

    const fee = await provider.getFeeData()
    const gas = fee.maxFeePerGas
      ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? fee.maxFeePerGas }
      : { gasPrice: fee.gasPrice }

    const weth = new ethers.Contract(c.weth, WETH_ABI, wallet)
    const router = new ethers.Contract(c.router, ROUTER_ABI, wallet)
    const stock = new ethers.Contract(address, ERC20_ABI, provider)

    const wbal = await weth.balanceOf(wallet.address)
    if (wbal < budget) {
      const t = await weth.deposit({ value: budget - wbal, gasLimit: 150_000n, ...gas })
      await t.wait()
    }
    if (!wethApproved) {
      const allowance = await weth.allowance(wallet.address, c.router)
      if (allowance < budget) {
        const t = await weth.approve(c.router, ethers.MaxUint256, { gasLimit: 150_000n, ...gas })
        await t.wait()
      }
      wethApproved = true
    }

    // quote with a static call first: these pools are thin and a blind swap can
    // land at a price nobody would have accepted
    const deadline = Math.floor(now() / 1000) + 1200
    const iface = new ethers.Interface(ROUTER_ABI)
    const args = [c.weth, address, c.poolDeployer, wallet.address, deadline, budget, 0n, 0n]
    let quoted = 0n
    try {
      const res = await provider.call({
        from: wallet.address,
        to: c.router,
        data: iface.encodeFunctionData('exactInputSingle', [args]),
      })
      ;[quoted] = iface.decodeFunctionResult('exactInputSingle', res)
    } catch (e) {
      throw new Error(`quote reverted: ${(e.shortMessage || e.message || '').slice(0, 90)}`)
    }
    if (quoted <= 0n) throw new Error('quote is zero — no pool liquidity')

    const minOut = (quoted * BigInt(100 - Math.round(c.slippagePct))) / 100n
    const before = await stock.balanceOf(wallet.address)
    const tx = await router.exactInputSingle(
      [c.weth, address, c.poolDeployer, wallet.address, deadline, budget, minOut, 0n],
      { gasLimit: 700_000n, ...gas }
    )
    const rc = await tx.wait()
    const after = await stock.balanceOf(wallet.address)
    const bought = after - before
    if (rc.status !== 1 || bought <= 0n) throw new Error('swap failed')
    return { amount: fmtUnits(bought, dec), raw: bought, eth: fmtUnits(budget, 18), tx: tx.hash, dec }
  }

  // -- distribute --------------------------------------------------------

  async function distribute(ticker, address, dec, round) {
    const rows = holders?.rows || []
    if (!rows.length) throw new Error('no eligible holders')
    if (now() - (holders?.ts || 0) > c.holdersStaleMs) {
      throw new Error('holder snapshot is stale — refusing to pay out over frozen data')
    }

    let potRaw
    const stock = provider ? new ethers.Contract(address, ERC20_ABI, wallet || provider) : null
    if (dryRun) potRaw = ethers.parseUnits('100', dec)
    else potRaw = await stock.balanceOf(wallet.address)
    if (potRaw <= 0n) throw new Error(`pot holds no ${ticker}`)

    // pro-rata on exact raw balances — no float anywhere near the split
    const totalW = rows.reduce((a, r) => a + r.raw, 0n)
    if (totalW <= 0n) throw new Error('eligible holders hold nothing')
    const payouts = rows
      .map((r) => ({ ...r, raw_out: (potRaw * r.raw) / totalW }))
      .filter((p) => p.raw_out > 0n)
    if (!payouts.length) throw new Error('every cut rounds to zero')

    const items = []
    let sent = 0n

    const record = (p, hash) => {
      sent += p.raw_out
      const item = {
        to: p.address,
        rank: p.rank,
        pct: p.pct,
        held: p.amount,
        amount: fmtUnits(p.raw_out, dec),
        tx: hash,
        txUrl: explorerTx(hash),
        addrUrl: explorerAddr(p.address),
      }
      items.push(item)
      emit({ type: 'airdropPayment', ticker, ...item })
    }

    if (dryRun) {
      for (const p of payouts) {
        record(p, fakeHash())
        await sleep(30) // stream them out so the frontend fills in visibly
      }
    } else {
      const fee = await provider.getFeeData()
      const maxFee = fee.maxFeePerGas || fee.gasPrice || 1n
      const gas = fee.maxFeePerGas
        ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? fee.maxFeePerGas }
        : { gasPrice: fee.gasPrice }
      let gasLimit = c.payoutGas
      try {
        const est = await stock.transfer.estimateGas(ethers.getAddress(payouts[0].address), payouts[0].raw_out)
        gasLimit = est * 2n
        if (gasLimit < 200_000n) gasLimit = 200_000n
      } catch {}
      const need = BigInt(payouts.length + 2) * gasLimit * maxFee
      const native = await provider.getBalance(wallet.address)
      if (native < need) {
        console.warn(
          `[airdrop] gas ${fmtUnits(native, 18)} ETH < ~${fmtUnits(need, 18)} needed for ${payouts.length} sends`
        )
      }

      let nonce = await wallet.getNonce()
      let failures = 0
      for (const p of payouts) {
        let hash = null
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const tx = await stock.transfer(ethers.getAddress(p.address), p.raw_out, { nonce, gasLimit, ...gas })
            hash = tx.hash
            break
          } catch (e) {
            const msg = String(e?.message || e).toLowerCase()
            // A timeout or "nonce too low" does NOT mean the transfer failed. If
            // the chain's pending nonce moved past ours it landed — record it and
            // never retry, or the holder gets paid twice.
            if (/nonce|coalesce|timeout/.test(msg)) {
              try {
                const pend = await wallet.getNonce('pending')
                if (pend > nonce) { hash = `sent-nonce-${nonce}`; break }
                nonce = pend
              } catch {}
              await sleep(1200 * (attempt + 1))
              continue
            }
            if (/rate|limit|-32007/.test(msg)) { await sleep(1200 * (attempt + 1)); continue }
            break
          }
        }
        if (!hash) { failures++; await sleep(c.sendDelayMs); continue }
        nonce++
        record(p, hash)
        await sleep(c.sendDelayMs)
      }
      if (failures) console.warn(`[airdrop] ${failures} transfer(s) failed`)
    }

    return { items, totalSent: fmtUnits(sent, dec) }
  }

  // -- the hook ----------------------------------------------------------

  /** Called with the round's winner. Buys the stock, then pays it out. */
  async function onRoundWinner(winner, round) {
    if (!enabled || !winner) return
    if (busy) {
      console.warn('[airdrop] previous airdrop still running — skipping this round')
      return
    }
    const address = STOCK_TOKENS[winner.symbol]
    if (!address) {
      console.warn(`[airdrop] no tokenized stock known for ${winner.symbol}`)
      return
    }
    busy = true
    try {
      emit({
        type: 'airdropStart',
        round,
        ticker: winner.symbol,
        name: winner.name,
        color: winner.color,
        holders: holders?.rows?.length ?? 0,
        dryRun,
        demo: !!holders?.demo,
        explorer: c.explorer,
        token: c.token,
        tokenSymbol,
      })

      const buy = await buyStock(winner.symbol, address)
      emit({
        type: 'airdropBuy',
        ticker: winner.symbol,
        amount: buy.amount,
        eth: buy.eth,
        tx: buy.tx,
        txUrl: explorerTx(buy.tx),
        dryRun,
      })

      const { items, totalSent } = await distribute(winner.symbol, address, buy.dec, round)

      // File it before announcing it: the leaderboard the frontend is about to
      // let people open should already have this round in it.
      await db?.recordDistribution({
        round,
        ticker: winner.symbol,
        name: winner.name,
        usdPerUnit: winner.price || null,
        items,
        buy: { amount: buy.amount, eth: buy.eth, tx: buy.tx },
        dryRun,
        demo: !!holders?.demo,
      })

      emit({
        type: 'airdropResult',
        round,
        ticker: winner.symbol,
        name: winner.name,
        color: winner.color,
        totalSent,
        totalUsd: winner.price ? totalSent * winner.price : null,
        usdPerUnit: winner.price || null,
        count: items.length,
        items,
        buy: { amount: buy.amount, eth: buy.eth, tx: buy.tx, txUrl: explorerTx(buy.tx) },
        explorer: c.explorer,
        dryRun,
        demo: !!holders?.demo,
      })
      console.info(
        `[airdrop]${dryRun ? ' DRY' : ''} sent ${totalSent} ${winner.symbol} to ${items.length} holders`
      )
    } catch (e) {
      console.error('[airdrop] failed:', e.message)
      emit({ type: 'airdropError', ticker: winner.symbol, message: String(e.message || e) })
    } finally {
      busy = false
      pollHolders() // refresh for the next round
    }
  }

  return {
    onRoundWinner,
    get enabled() { return enabled },
    get dryRun() { return dryRun },
    /** Everything needed to debug holder detection on a new launchpad token. */
    diagnostics() {
      return diagnostics || { ts: null, token: c.token || null, rejected: 'no crawl yet' }
    },
    refreshHolders: pollHolders,
    probe,
    simulate,
    potSnapshot: () => pot,
    snapshot() {
      return {
        enabled,
        dryRun,
        poolsExcluded: poolSet.size,
        token: c.token || null,
        tokenSymbol,
        explorer: c.explorer,
        eligibleHolders: holders?.rows?.length ?? 0,
        demo: !!holders?.demo,
        holdersAt: holders?.ts ?? null,
        wallet: wallet ? wallet.address : null,
      }
    },
    start() {
      // The pot is published whenever there is a wallet to read, armed or not:
      // you fund it, watch the number appear on screen, and only then flip
      // AIRDROP on. Gating this behind `enabled` meant the pot stayed blank
      // right up until the moment it started spending itself.
      if (wallet) {
        pollPot()
        potTimer = setInterval(pollPot, c.potPollMs)
      }
      if (!enabled) {
        if (isAddr(c.token)) loadTokenMeta()
        console.info(
          `[airdrop] disabled (set AIRDROP=1 to arm it)${wallet ? ' — pot balance still being published' : ''}`
        )
        return
      }
      console.info(
        `[airdrop] armed${dryRun ? ' in DRY RUN — no funds move' : ''} · token ${c.token || '(unset)'} · ` +
          `pot ${wallet ? wallet.address : '(no key)'}`
      )
      pollHolders()
      holdersTimer = setInterval(pollHolders, c.holdersPollMs)
    },
    stop() {
      clearInterval(holdersTimer)
      clearInterval(potTimer)
    },
  }
}
