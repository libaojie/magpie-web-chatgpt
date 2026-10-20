// The site's own HTTP contract: browser headers, the session endpoints and the
// sentinel requirements call. Everything here is what chatgpt.com's own web
// client sends; no other address is contacted.

import { DEFAULT_USER_AGENT, SEC_CH_UA } from "./config.mjs"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// The magpie plugin host runs on Bun, whose BoringSSL TLS fingerprint
// chatgpt.com's Cloudflare challenges (403) — while Node's OpenSSL passes.
// When the runtime is Bun, site traffic is relayed through a one-shot node
// subprocess (scripts/fetch-bridge.mjs); other runtimes fetch directly.
const IS_BUN = typeof globalThis.Bun !== "undefined"
const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fetch-bridge.mjs")

function findNode() {
  for (const name of ["node"]) {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      const path = join(dir, name)
      if (existsSync(path)) return path
    }
  }
  return "node"
}

async function bridgeFetch(url, init) {
  const spec = { url, method: init?.method, headers: init?.headers, body: init?.body, timeoutMs: init?.timeoutMs }
  const node = findNode()
  const run = (args) => new Promise((resolve, reject) => {
    execFile(node, [BRIDGE, ...args], {
      timeout: (spec.timeoutMs ?? 120_000) + 15_000,
      maxBuffer: 256 * 1024 * 1024,
      // node's fetch only honors *_PROXY with this opt-in, and the bridge must
      // take the same route the host's own traffic takes.
      env: { ...process.env, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? "1" },
    }, (error, stdout, stderr) => {
      if (stdout) resolve(stdout)
      else reject(new Error(`fetch bridge: ${stderr.trim().slice(0, 200) || error?.message || "no output"}`))
    })
  })
  let reply = null
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      reply = JSON.parse(await run(["--spec", JSON.stringify(spec)]))
      if (reply.error) {
        // a connect-timeout reply is the proxy's flake, not the site's answer
        if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|UND_ERR_CONNECT/i.test(reply.error)) {
          lastError = new Error(`fetch bridge: ${reply.error}`)
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)))
          continue
        }
        throw new Error(`fetch bridge: ${reply.error}`)
      }
      break
    } catch (error) {
      if (error instanceof SyntaxError) throw error
      lastError = error
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)))
    }
  }
  if (!reply) throw lastError ?? new Error("fetch bridge: no reply")
  return {
    status: reply.status,
    ok: reply.status >= 200 && reply.status < 300,
    headers: new Headers(reply.headers ?? {}),
    async text() {
      return Buffer.from(reply.bodyBase64 ?? "", "base64").toString("utf8")
    },
    async json() {
      return JSON.parse(Buffer.from(reply.bodyBase64 ?? "", "base64").toString("utf8"))
    },
  }
}

// siteFetch is every request this plugin makes to the site.
async function siteFetch(url, init = {}) {
  if (IS_BUN) return bridgeFetch(url, init)
  return fetch(url, init)
}

// siteFetchStream is the streaming variant; on Bun it yields SSE lines through
// repeated bridge calls is too costly, so it shells out to the bridge in
// stream mode and reads JSON-lines off its stdout incrementally.
async function siteFetchStream(url, init = {}) {
  if (!IS_BUN) return fetch(url, init)
  const { spawn } = await import("node:child_process")
  const spec = { url, method: init?.method, headers: init?.headers, body: init?.body, timeoutMs: init?.timeoutMs }
  const child = spawn(findNode(), [BRIDGE, "--spec", JSON.stringify(spec), "--stream"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? "1" },
  })
  const decoder = new TextDecoder()
  let buffer = ""
  const queue = []
  let wake = null
  child.stdout.on("data", (data) => {
    buffer += decoder.decode(data, { stream: true })
    let index
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      try {
        queue.push(JSON.parse(line))
      } catch {
        // a torn line waits for the next chunk
      }
      wake?.()
      wake = null
    }
  })
  const exit = new Promise((resolve) => child.on("close", (code) => resolve({ code })))
  child.stderr.resume()

  const head = await new Promise((resolve, reject) => {
    const check = () => {
      if (queue.length) {
        const first = queue.shift()
        if (first.error) reject(new Error(`fetch bridge: ${first.error}`))
        else resolve(first)
        return true
      }
      return false
    }
    if (!check()) {
      const timer = setTimeout(() => reject(new Error("fetch bridge: no response head")), 60_000)
      const poll = setInterval(() => {
        if (check()) { clearTimeout(timer); clearInterval(poll) }
      }, 25)
      child.on("close", () => { clearInterval(poll); clearTimeout(timer); reject(new Error("fetch bridge: exited before the head")) })
    }
  })

  const response = {
    status: head.status,
    ok: head.status >= 200 && head.status < 300,
    headers: new Headers(head.headers ?? {}),
    text: async () => {
      const chunks = []
      for (;;) {
        const next = queue.shift()
        if (next?.done) break
        if (next?.chunkB64) chunks.push(Buffer.from(next.chunkB64, "base64"))
        else await Promise.race([new Promise((r) => (wake = r)), exit])
        if (next?.chunkB64) continue
      }
      return Buffer.concat(chunks).toString("utf8")
    },
    body: {
      async *getReader() {}, // not used directly
      [Symbol.asyncIterator]: async function* () {
        for (;;) {
          const next = queue.shift()
          if (next?.done) return
          if (next?.chunkB64) {
            yield Buffer.from(next.chunkB64, "base64")
            continue
          }
          const raced = await Promise.race([new Promise((r) => (wake = r)).then(() => "wakeup"), exit.then(() => "exit")])
          if (raced === "exit" && !queue.length) return
        }
      },
    },
  }
  return response
}

function browserHeaders(origin, { cookie, accessToken, userAgent, extra = {} } = {}) {
  const headers = {
    accept: "application/json",
    "user-agent": userAgent ?? DEFAULT_USER_AGENT,
    "sec-ch-ua": SEC_CH_UA,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "accept-language": "en-US,en;q=0.9",
    "oai-language": "en-US",
    origin,
    referer: `${origin}/`,
    ...extra,
  }
  if (cookie) headers.cookie = cookie
  if (accessToken) headers.authorization = `Bearer ${accessToken}`
  return headers
}

// cookieName splits a Set-Cookie header list into per-request updates.
function applySetCookie(jar, setCookies, origin) {
  const host = new URL(origin).hostname
  for (const raw of setCookies ?? []) {
    const [pair, ...attributes] = String(raw).split(";")
    const at = pair.indexOf("=")
    if (at <= 0) continue
    const name = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    const options = new Map(attributes.map((attribute) => {
      const at = attribute.indexOf("=")
      return [attribute.slice(0, at < 0 ? undefined : at).trim().toLowerCase(), at < 0 ? "" : attribute.slice(at + 1).trim()]
    }))
    const domain = (options.get("domain") ?? host).replace(/^\./, "").toLowerCase()
    if (domain !== host && !host.endsWith(`.${domain}`)) continue
    const path = options.get("path") ?? "/"
    if (path !== "/") continue
    const maxAge = options.get("max-age")
    const expired = maxAge ? Number(maxAge) <= 0 : Date.parse(options.get("expires") ?? "") <= Date.now()
    jar.delete(`${domain} ${name}`)
    if (!expired) jar.set(`${domain} ${name}`, `${name}=${value}`)
  }
}

function jarHeader(jar) {
  return [...jar.values()].join("; ")
}

// session asks /api/auth/session with the cookie jar and folds the rotated
// Set-Cookie values back in — the site re-issues the session shards often, and
// dropping the rotation breaks the jar within a day.
async function session(origin, jar, { userAgent, signal } = {}) {
  const response = await siteFetch(`${origin}/api/auth/session`, {
    headers: browserHeaders(origin, { cookie: jarHeader(jar), userAgent }),
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  const setCookies = response.headers.getSetCookie?.() ?? []
  applySetCookie(jar, setCookies, origin)
  if (response.status === 401 || response.status === 403) throw new Error("ChatGPT: the sign-in was refused — sign in again")
  const value = await response.json().catch(() => null)
  if (!value || typeof value.accessToken !== "string" || !value.accessToken.trim()) {
    throw new Error("ChatGPT: the session expired — sign in to chatgpt.com again")
  }
  return { ...value, cookie: jarHeader(jar) }
}

// models reads the account's catalogue. Falls back to the static list when the
// site refuses (the models are the same names the picker shows).
async function models(origin, accessToken, { cookie, userAgent, signal } = {}) {
  const response = await siteFetch(`${origin}/backend-api/models?history_and_training_disabled=false`, {
    headers: browserHeaders(origin, { cookie, accessToken, userAgent }),
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  if (!response.ok) return null
  const value = await response.json().catch(() => null)
  const list = value?.models
  if (!Array.isArray(list)) return null
  return list
    .filter((model) => typeof model?.slug === "string" && model.slug && typeof model?.title === "string")
    .map((model) => ({ id: model.slug, name: model.title }))
}

export { browserHeaders, applySetCookie, jarHeader, session, models, siteFetch, siteFetchStream }
