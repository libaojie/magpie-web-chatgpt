#!/usr/bin/env node
// fetch-bridge: one-shot HTTPS relay used when the host runtime's TLS stack is
// challenged by the site (magpie's Bun host fails chatgpt.com's Cloudflare
// check; Node's OpenSSL passes). Reads one request spec from argv, performs it
// with Node's own fetch, and writes the response (headers + body) as JSON to
// stdout. Streaming bodies are forwarded over stdout as JSON-lines chunks.
//
// Usage: node fetch-bridge.mjs --spec '<json>' [--stream]
//   spec: {url, method, headers, body}
//   reply (non-stream): {status, headers, bodyBase64}
//   reply (stream):     first {status, headers}, then one {chunkB64} per
//                       chunk, then {done: true} — one JSON per line.
import { readFileSync } from "node:fs"

function arg(name) {
  const at = process.argv.indexOf(name)
  return at === -1 ? null : process.argv[at + 1]
}

const spec = JSON.parse(arg("--spec"))
const streaming = process.argv.includes("--stream")

const init = {
  method: spec.method ?? "GET",
  headers: spec.headers ?? {},
  signal: AbortSignal.timeout(spec.timeoutMs ?? 120_000),
}
if (spec.body != null) init.body = spec.body

try {
  const response = await fetch(spec.url, init)
  const headers = {}
  for (const [name, value] of response.headers) headers[name] = value
  if (!streaming || !(response.body && typeof response.body.getReader === "function")) {
    const body = Buffer.from(await response.arrayBuffer())
    process.stdout.write(JSON.stringify({ status: response.status, headers, bodyBase64: body.toString("base64") }))
    process.exit(0)
  }
  process.stdout.write(JSON.stringify({ status: response.status, headers }) + "\n")
  const decoder = new TextEncoder()
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    process.stdout.write(JSON.stringify({ chunkB64: Buffer.from(value).toString("base64") }) + "\n")
  }
  process.stdout.write(JSON.stringify({ done: true }) + "\n")
  process.exit(0)
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error?.cause?.code ?? error?.message ?? error) }))
  process.exit(0)
}
