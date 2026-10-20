// The sentinel proof-of-work, as the web client's own script computes it.
//
// chat-requirements answers with {seed, difficulty}; the client then searches
// for an `i` where sha3_512(seed + base64(json(config)))'s hex digest, cut to
// the difficulty's length, sorts at or under the difficulty string. The config
// is an 18-element array fingerprinting the browser; positions 3 and 9 carry
// the counter and the elapsed milliseconds. The token is "gAAAAAB" + that base.
//
// The requirements call itself takes a proof too ({"p": token}); a throwaway
// one at difficulty "0" — accepted on the first hash — is what the client sends.

import { createHash } from "node:crypto"
import { DEFAULT_USER_AGENT } from "./config.mjs"

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const CORES = [8, 12, 16, 24]
const SCREENS = [3000, 4000, 6000]
const MAX_SHELLS = 500_000

const b64 = (value) => Buffer.from(value).toString("base64")

// Chrome's own `Date.toString()` shape, as the client fingerprints with.
function chromeDateString(date) {
  const pad = (n) => String(n).padStart(2, "0")
  return (
    `${DAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${pad(date.getDate())} ${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    ` GMT+${date.getTimezoneOffset() <= 0 ? "" : "-"}${Math.abs(date.getTimezoneOffset() / 60)} (${tzName(date)})`
  )
}

function tzName(date) {
  // Intl reads the real zone name; the client's own string runs long, so this
  // only needs to be plausible, not exact.
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZoneName: "long" }).formatToParts(date)
    return part.find((p) => p.type === "timeZoneName")?.value ?? "China Standard Time"
  } catch {
    return "China Standard Time"
  }
}

// proofFor searches the counter and returns the accepted base payload.
function proofFor(seed, difficulty, { userAgent } = {}) {
  const start = Date.now()
  const sid = crypto.randomUUID()
  const bootAt = start - 60_000
  const config = [
    SCREENS[Math.floor(Math.random() * SCREENS.length)],
    chromeDateString(new Date()),
    4294705152,
    0,
    userAgent ?? DEFAULT_USER_AGENT,
    "",
    "prod-c2a",
    "en-US",
    "en-US",
    0,
    "webkitGetUserMedia−function webkitGetUserMedia() { [native code] }",
    "location",
    "ontransitionend",
    0,
    sid,
    "",
    CORES[Math.floor(Math.random() * CORES.length)],
    bootAt / 1000,
  ]
  const diffLen = difficulty.length
  for (let i = 0; i < MAX_SHELLS; i++) {
    config[3] = i
    config[9] = Date.now() - start
    const base = b64(JSON.stringify(config))
    const hex = createHash("sha3-512").update(seed + base).digest("hex")
    if (hex.slice(0, diffLen) <= difficulty) return base
  }
  return null
}

function proofToken(seed, difficulty, options) {
  const base = proofFor(seed, difficulty, options)
  return base ? "gAAAAAB" + base : null
}

export { proofFor, proofToken, chromeDateString }
