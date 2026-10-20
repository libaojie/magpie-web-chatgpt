// Browser-cookie sign-in: reads the chatgpt.com cookie jar out of a local
// Chromium-family profile on Linux. The cookies are encrypted by Chrome's
// os_crypt ("v11" = AES-128-CBC over PBKDF2-HMAC-SHA1(keyring secret,
// "saltysalt", 1 iteration, 16 bytes), IV = 16 spaces, with a 32-byte
// SHA256(host) domain separator inside the plaintext). The keyring secret
// ("Chrome Safe Storage") is read over the Secret Service D-Bus API the same
// way Chrome itself reads it. Nothing is written back to the profile.
//
// Dependencies (Debian/Ubuntu): python3 + python3-dbus + python3-cryptography,
// reached through a bundled helper script. On a headless server, use the paste
// sign-in instead.

import { execFile } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { session } from "./api.mjs"
import { DEFAULT_USER_AGENT } from "./config.mjs"

const HELPER = new URL("../scripts/dump-browser-cookies.py", import.meta.url)

// profilePaths lists the Cookies databases of installed Chromium-family
// browsers, newest browser first. This plugin is Linux-first; other platforms
// fall back to the paste sign-in.
function profilePaths() {
  if (process.platform !== "linux") return []
  const home = homedir()
  const bases = [
    join(home, ".config"),
    process.env.XDG_CONFIG_HOME ?? "",
  ].filter(Boolean)
  const names = [
    "google-chrome", "google-chrome-beta", "google-chrome-unstable",
    "chromium", "chromium-browser",
    "BraveSoftware/Brave-Browser",
    "microsoft-edge",
    "vivaldi",
  ]
  const out = []
  for (const base of bases) {
    for (const name of names) {
      const dataDir = join(base, name)
      if (!existsSync(dataDir)) continue
      let profiles
      try {
        profiles = readdirSync(dataDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of profiles) {
        if (!entry.isDirectory()) continue
        if (!/^(Default|Profile \d+)$/.test(entry.name)) continue
        const cookies = join(dataDir, entry.name, "Cookies")
        if (existsSync(cookies)) out.push(cookies)
      }
    }
  }
  return out
}

// dumpCookies runs the python helper against one profile and parses its TSV.
function dumpCookies(dbPath, hosts) {
  return new Promise((resolve, reject) => {
    const python = ["/usr/bin/python3", "python3"].find((bin) => existsSync(bin)) ?? "python3"
    execFile(python, [HELPER.pathname, "--db", dbPath, "--host", hosts.join(",")], { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`cookie dump failed: ${stderr.trim().slice(0, 200) || error.message}`))
        return
      }
      const pairs = []
      for (const line of stdout.split("\n")) {
        const [host, name, value] = line.split("\t")
        if (host && name && value) pairs.push(`${name}=${value}`)
      }
      resolve(pairs)
    })
  })
}

// findLiveCookie walks the local profiles and returns the first cookie jar that
// chatgpt.com accepts as a live session.
async function findLiveCookie(origin, signal) {
  const hosts = ["chatgpt.com", ".chatgpt.com", "auth.openai.com", ".openai.com"]
  for (const dbPath of profilePaths()) {
    let pairs
    try {
      pairs = await dumpCookies(dbPath, hosts)
    } catch {
      continue
    }
    if (!pairs.length) continue
    const cookie = pairs.join("; ")
    try {
      const jar = new Map(cookie.split("; ").map((pair) => [pair.slice(0, pair.indexOf("=")), pair]))
      const who = await session(origin, jar, { signal })
      return { cookie: [...jar.values()].join("; "), who: who.user ?? {}, from: dbPath, userAgent: DEFAULT_USER_AGENT }
    } catch {
      // try the next profile
    }
  }
  return null
}

export { profilePaths, findLiveCookie }
