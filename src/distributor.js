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

export function createDistributor({ onEvent }) {
  const c = config.chain
  const enabled = c.airdrop
  const provider = c.rpcUrl ? new ethers.JsonRpcProvider(c.rpcUrl, c.chainId) : null
  const wallet = c.privateKey && provider ? new ethers.Wallet(c.privateKey, provider) : null
  const dryRun = c.dryRun || !wallet || !isAddr(c.token)

  const stockDecimals = new Map()
  let tokenDecimals = 18
  let tokenTotalSupply = 0n
  let holders = null // { ts, rows:[{address, raw, amount, pct}] }
  let contractHolders = new Set()
  let wethApproved = false
  let busy = false
  let holdersTimer = null

  const emit = (e) => onEvent({ ...e, ts: e.ts ?? now() })
  const bsAuth = () => (c.blockscoutKey ? { apikey: c.blockscoutKey } : {})
  const explorerTx = (hash) => `${c.explorer}/tx/${hash}`
  const explorerAddr = (a) => `${c.explorer}/address/${a}`

  // -- Blockscout --------------------------------------------------------

  async function getJson(base, path, params) {
    const url = new URL(base + path)
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null) url.searchParams.set(k, String(v))
    }
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new Error(`${path} -> ${r.status}`)
    return r.json()
  }

  /**
   * One complete crawl of the memecoin's holders. Built into local structures
   * and only applied whole: a crawl that dies half way is thrown away, never
   * distributed over, or the last page of holders would silently get nothing.
   */
  async function crawlHolders(base, useAuth) {
    const map = new Map()
    const contracts = new Set()
    let params = useAuth ? { ...bsAuth() } : {}
    for (let page = 0; page < 500; page++) {
      let data = null
      for (let tries = 0; tries < 5; tries++) {
        try {
          data = await getJson(base, `/api/v2/tokens/${c.token}/holders`, params)
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
      if (d?.total_supply != null) tokenTotalSupply = BigInt(d.total_supply)
      if (tokenTotalSupply > 0n) return
    } catch {}
    if (!provider) return
    const t = new ethers.Contract(c.token, ERC20_ABI, provider)
    try { tokenDecimals = Number(await t.decimals()) } catch {}
    try { tokenTotalSupply = await t.totalSupply() } catch {}
  }

  const isExcluded = (addr) =>
    addr === ZERO ||
    addr === DEAD ||
    addr === wallet?.address?.toLowerCase() ||
    c.exclude.has(addr) ||
    (c.excludeContracts && contractHolders.has(addr))

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
      let res
      try {
        res = await crawlHolders(c.blockscout, true)
      } catch (e) {
        if (c.blockscoutPublic && c.blockscoutPublic !== c.blockscout) {
          console.warn(`[airdrop] holders crawl failed (${e.message}) — retrying via public instance`)
          res = await crawlHolders(c.blockscoutPublic, false)
        } else throw e
      }
      contractHolders = res.contracts

      const supply = fmtUnits(tokenTotalSupply, tokenDecimals)
      const rows = []
      for (const [address, raw] of res.map) {
        if (raw <= 0n || isExcluded(address)) continue
        const amount = fmtUnits(raw, tokenDecimals)
        const pct = supply > 0 ? (amount / supply) * 100 : 0
        if (pct < c.minPct || pct > c.maxPct) continue
        rows.push({ address, raw, amount, pct })
      }
      rows.sort((a, b) => b.amount - a.amount)
      rows.forEach((r, i) => (r.rank = i + 1))
      holders = { ts: now(), rows, supply, total: res.map.size }
      console.info(
        `[airdrop] ${rows.length} eligible holders of ${c.token} (${res.contracts.size} contracts skipped)`
      )
    } catch (e) {
      console.error('[airdrop] holders poll:', e.message)
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
      emit({
        type: 'airdropResult',
        round,
        ticker: winner.symbol,
        name: winner.name,
        color: winner.color,
        totalSent,
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
    snapshot() {
      return {
        enabled,
        dryRun,
        token: c.token || null,
        explorer: c.explorer,
        eligibleHolders: holders?.rows?.length ?? 0,
        demo: !!holders?.demo,
        holdersAt: holders?.ts ?? null,
        wallet: wallet ? wallet.address : null,
      }
    },
    start() {
      if (!enabled) {
        console.info('[airdrop] disabled (set AIRDROP=1 to arm it)')
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
    },
  }
}
