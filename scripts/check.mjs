// Local smoke: load the plugin the way the host does and run one turn against
// the live site, using the cookie header from the experiment run.
// Usage: NODE_USE_ENV_PROXY=1 HTTPS_PROXY=… node scripts/check.mjs
import { readFileSync } from "node:fs"

const mod = await import("../src/index.mjs")
const plugin = mod.default
console.log("plugin id:", plugin.id)

const instance = await plugin.server({}, {})
let providerConfig = null
await instance.config({ provider: (providerConfig = {}) })
console.log("provider declared:", providerConfig[plugin.id]?.name)

// auth via a pasted cookie header (the same path `magpie plugin login` uses)
const cookie = process.env.CGPT_COOKIE ?? readFileSync("/tmp/cookie-header.txt", "utf8").trim()
const auth = { key: cookie, metadata: { source: "pasted", userAgent: undefined } }

const loader = instance.auth.loader
const served = await loader(async () => auth)
console.log("loader ready, baseURL:", served.baseURL)

const models = await served.models()
console.log("models:", Object.keys(models))

// one chat completion through the plugin's own fetch (streaming)
const body = JSON.stringify({
  model: "auto",
  stream: true,
  messages: [{ role: "user", content: "Reply with exactly: PONG" }],
})
const response = await served.fetch("https://chatgpt.com/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
})
console.log("fetch status:", response.status, response.headers.get("content-type"))
const text = await response.text()
const deltas = []
for (const line of text.split("\n")) {
  if (!line.startsWith("data: ") || line === "data: [DONE]") continue
  try {
    const frame = JSON.parse(line.slice(6))
    const delta = frame.choices?.[0]?.delta?.content
    if (delta) deltas.push(delta)
  } catch {}
}
console.log("reply:", JSON.stringify(deltas.join("")))
console.log(deltas.join("").trim() === "PONG" ? "SMOKE OK" : "SMOKE MISMATCH")
