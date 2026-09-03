// ============================================================================
// marketHours.js — which US equity session are we in, right now?
//
//   pre      04:00 – 09:30 ET
//   regular  09:30 – 16:00 ET
//   post     16:00 – 20:00 ET
//   closed   everything else (nights, weekends, holidays)
//
// The game only runs rounds while the tape is live (pre / regular / post);
// when it's closed the frontend shows a countdown to the next session instead
// of crowning a winner on a frozen tape.
//
// All wall-clock reasoning goes through Intl in America/New_York, so DST is
// handled by the platform. "When does this change?" is answered by scanning
// forward in time rather than doing offset arithmetic — same reason.
// ============================================================================

const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** NYSE/Nasdaq full holidays. Update once a year (see README). */
const HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
])

/** Early closes: regular session ends 13:00 ET, post-market ends 17:00 ET. */
const HALF_DAYS = new Set([
  '2026-11-27', '2026-12-24',
  '2027-11-26',
])

const PRE_OPEN = 4 * 60 // 04:00
const OPEN = 9 * 60 + 30 // 09:30
const CLOSE = 16 * 60 // 16:00
const POST_CLOSE = 20 * 60 // 20:00
const HALF_CLOSE = 13 * 60 // 13:00
const HALF_POST_CLOSE = 17 * 60 // 17:00

/** ET wall-clock parts for an instant: { date:'YYYY-MM-DD', minutes, dow }. */
function etParts(ts) {
  const p = Object.fromEntries(FMT.formatToParts(new Date(ts)).map((x) => [x.type, x.value]))
  const date = `${p.year}-${p.month}-${p.day}`
  // getUTCDay of the ET calendar date == the ET day of week
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
  return { date, minutes: Number(p.hour) % 24 * 60 + Number(p.minute), dow }
}

/** 'pre' | 'regular' | 'post' | 'closed' for an instant (default: now). */
export function sessionAt(ts = Date.now()) {
  const { date, minutes, dow } = etParts(ts)
  if (dow === 0 || dow === 6) return 'closed'
  if (HOLIDAYS.has(date)) return 'closed'
  const half = HALF_DAYS.has(date)
  const close = half ? HALF_CLOSE : CLOSE
  const postClose = half ? HALF_POST_CLOSE : POST_CLOSE
  if (minutes < PRE_OPEN) return 'closed'
  if (minutes < OPEN) return 'pre'
  if (minutes < close) return 'regular'
  if (minutes < postClose) return 'post'
  return 'closed'
}

export const isLive = (ts = Date.now()) => sessionAt(ts) !== 'closed'

export const SESSION_LABEL = Object.freeze({
  pre: 'PRE-MARKET',
  regular: 'MARKET OPEN',
  post: 'AFTER HOURS',
  closed: 'MARKET CLOSED',
})

/**
 * The next instant the session label changes, found by scanning forward:
 * a coarse 15-minute sweep (up to 10 days) then a 1-minute refine. Cheap
 * enough to call on every session flip, and immune to DST/offset bugs.
 */
export function nextSessionChange(from = Date.now()) {
  const cur = sessionAt(from)
  const COARSE = 15 * 60 * 1000
  const MINUTE = 60 * 1000
  const limit = from + 10 * 24 * 60 * 60 * 1000
  let t = from
  while (t < limit) {
    const next = t + COARSE
    if (sessionAt(next) !== cur) {
      for (let m = t + MINUTE; m <= next; m += MINUTE) {
        if (sessionAt(m) !== cur) return { at: m, state: sessionAt(m) }
      }
      return { at: next, state: sessionAt(next) }
    }
    t = next
  }
  return { at: limit, state: sessionAt(limit) }
}

/** A full session descriptor for the wire: what it is + when it flips. */
export function sessionInfo(ts = Date.now()) {
  const state = sessionAt(ts)
  const { at, state: nextState } = nextSessionChange(ts)
  return {
    type: 'session',
    ts,
    state,
    label: SESSION_LABEL[state],
    live: state !== 'closed',
    nextChangeAt: at,
    nextState,
  }
}
