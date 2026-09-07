// ============================================================================
// rpc.js — ONE provider for the whole process, and it backs off instead of
// giving up.
//
// Learned the expensive way on The Retarded Index. Robinhood Chain's public
// node sits behind Cloudflare, and Cloudflare does not merely rate-limit a
// noisy client — it escalates to a managed challenge and then answers every
// subsequent request with a 403 HTML page. That page is not a transport error
// ethers knows how to wait out, so one burst during a payout took the whole
// backend down with it: prices blank, the holder crawl failing, and rounds
// refusing for hours after the node itself had recovered.
//
// Three things prevent it:
//
//   · ONE provider, shared. Holder discovery, the pot balance, the quotes and
//     the transfers all talk to the same node, so they share its connection and
//     its rate limit instead of quietly opening four and racing each other into
//     the challenge.
//   · Requests are THROTTLED, so a burst is spread out rather than fired at
//     once. The payout leg alone is one transaction per holder.
//   · 429 and 403 are RETRIED with growing delays instead of thrown. A
//     challenge then costs a few seconds, not a round.
// ============================================================================

import { ethers } from 'ethers'

export function createConnection(url, { maxAttempts = 6, slotInterval = 120 } = {}) {
  const req = new ethers.FetchRequest(url)
  req.timeout = 30_000
  req.setThrottleParams({ slotInterval, maxAttempts })
  req.retryFunc = async (_req, resp, attempt) => {
    if (attempt >= maxAttempts) return false
    // 429 is the polite refusal; 403 is Cloudflare's challenge page. Both mean
    // "you are going too fast", and both clear on their own if we wait.
    if (resp.statusCode !== 429 && resp.statusCode !== 403) return false
    const wait = Math.min(8000, 400 * 2 ** attempt)
    console.warn(`[rpc] ${resp.statusCode} from the node — backing off ${wait}ms (attempt ${attempt + 1}/${maxAttempts})`)
    await new Promise((r) => setTimeout(r, wait))
    return true
  }
  return req
}

/**
 * The process's single provider. Reads are coalesced into batches rather than
 * one HTTP request per call — fewer, larger requests is exactly what the edge
 * wants to see from us, and holder discovery makes hundreds of balanceOf calls
 * in a row.
 */
export function createProvider(url, chainId) {
  if (!url) return null
  return new ethers.JsonRpcProvider(createConnection(url), chainId, {
    batchMaxCount: 20,
    batchStallTime: 20,
  })
}
