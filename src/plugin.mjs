// The plugin.
//
// `server` is the OpenCode/magpie plugin function: it declares the provider,
// signs in (from the local Chrome profile's cookies or a pasted cookie header),
// and hands the AI SDK a fetch that speaks chatgpt.com's backend-api and
// answers in OpenAI chat completions.

import {
  PROVIDER,
  NAME,
  NPM,
  DEFAULT_ORIGIN,
  DEFAULT_USER_AGENT,
  CHAT_PATHS,
  configModels,
  accountLabel,
} from "./config.mjs"
import { session, models as readModels } from "./api.mjs"
import { runTurn } from "./turn.mjs"
import { encoder, chunk, finishReason, messagesToPrompt, messageSignature } from "./openai.mjs"

export const server = async (_input, _options) => {
  const origin = _options?.origin ?? DEFAULT_ORIGIN
  const CHATGPT = {
    name: NAME,
    npm: NPM,
    api: origin,
    models: configModels(),
  }
  return {
    config(config) {
      config.provider ??= {}
      config.provider[PROVIDER] ??= CHATGPT
    },
    async "chat.headers"(input, output) {
      if (input?.model?.providerID !== PROVIDER && input?.model?.providerID !== `${PROVIDER}-plugin`) return
      if (!input.sessionID) return
      output.headers["x-magpie-session"] = input.sessionID
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "Paste a chatgpt.com Cookie header (DevTools → any /backend-api request → Cookie)",
          placeholder: "__Secure-next-auth.session-token.0=…; oai-did=…; cf_clearance=…",
          // The host hands an api method's answered prompts, not the key: the
          // key is given to the sign-in separately and saved from there.
          async authorize(inputs) {
            const cookie = String(inputs?.token ?? inputs?.key ?? "").trim()
            if (!cookie) return { type: "success", metadata: { source: "pasted" } }
            const who = await checkCookie(origin, cookie).catch(() => null)
            if (!who) {
              return {
                type: "failed",
                error:
                  "ChatGPT refused that cookie header — copy the full Cookie header of a request to " +
                  "chatgpt.com/backend-api/* from a signed-in chatgpt.com tab (DevTools → Network). " +
                  "Keep the User-Agent of that browser at hand: cf_clearance is bound to it.",
              }
            }
            return {
              type: "success",
              key: cookie,
              accountId: who.email || who.name || accountLabel(cookie),
              name: who.name || undefined,
              metadata: { source: "pasted", userAgent: who.userAgent },
            }
          },
        },
        {
          type: "oauth",
          label: "Read the session from this machine's Chrome/Chromium profile (Linux desktop)",
          async authorize() {
            return {
              url: `${origin}/`,
              instructions:
                "Reading the chatgpt.com cookies from this machine's Chrome/Chromium profile. " +
                "If none is signed in, sign in to https://chatgpt.com in the local browser and run this again. " +
                "On a headless server use the paste sign-in instead.",
              method: "auto",
              async callback() {
                let found = null
                try {
                  const { findLiveCookie } = await import("./browser-cookie.mjs")
                  found = await findLiveCookie(origin)
                } catch {
                  found = null
                }
                if (!found) {
                  return {
                    type: "failed",
                    error:
                      "No live chatgpt.com session was found in this machine's browsers. " +
                      "Sign in to https://chatgpt.com locally and retry — or use the paste sign-in.",
                  }
                }
                return {
                  type: "success",
                  key: found.cookie,
                  accountId: found.who?.email || accountLabel(found.cookie),
                  name: found.who?.name || undefined,
                  metadata: { source: found.from, userAgent: found.userAgent },
                }
              },
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        const cookie = auth?.key
        if (!cookie) return {}
        const userAgent = auth?.metadata?.userAgent ?? DEFAULT_USER_AGENT

        const fetchModels = async (signal) => {
          try {
            const jar = new Map(cookie.split("; ").map((pair) => [pair.slice(0, pair.indexOf("=")), pair]))
            const live = await session(origin, jar, { userAgent, signal })
            const list = await readModels(origin, live.accessToken, { cookie: [...jar.values()].join("; "), userAgent, signal })
            if (list?.length) {
              return Object.fromEntries(list.map((model) => [
                model.id,
                {
                  name: model.name,
                  reasoning: false,
                  tool_call: false,
                  attachment: false,
                  modalities: { input: ["text"], output: ["text"] },
                  limit: { context: 128_000, output: 32_768 },
                  cost: { input: 0, output: 0 },
                },
              ]))
            }
          } catch {
            // offline catalogue: the static list still names the models
          }
          return configModels()
        }

        return {
          baseURL: origin,
          apiKey: "managed-locally",
          models: fetchModels,
          // The host calls this as `fetch(url, init)` with a string URL (as
          // the AI SDK does); OpenCode may hand a Request instead. Accept both.
          async fetch(input, init) {
            const request = input instanceof Request ? input : new Request(input, init)
            const url = new URL(request.url)
            if (!CHAT_PATHS[url.pathname] || request.method !== "POST") {
              throw new Error(`ChatGPT: unsupported request ${request.method} ${url.pathname}`)
            }
            const body = await request.json()
            const fresh = await getAuth()
            const live = fresh?.key ?? cookie
            if (!live) throw new Error("ChatGPT: not signed in")
            const liveUA = fresh?.metadata?.userAgent ?? userAgent
            const streaming = body.stream !== false
            const id = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`
            const created = Math.floor(Date.now() / 1000)
            const messages = body.messages ?? []
            const prompt = messagesToPrompt(messages)
            if (!prompt) throw new Error("ChatGPT: the request carries no text")

            const stream = new ReadableStream({
              async start(controller) {
                let sent = 0
                let last = null
                let failure = null
                try {
                  const turn = runTurn({
                    origin,
                    cookie: live,
                    accessToken: null,
                    model: body.model,
                    prompt,
                    userAgent: liveUA,
                    signal: request.signal,
                  })
                  // accessToken comes from a live session read, not from the jar:
                  // runTurn takes it resolved, so fetch it here once.
                  const jar = new Map(live.split("; ").map((pair) => [pair.slice(0, pair.indexOf("=")), pair]))
                  const liveSession = await session(origin, jar, { userAgent: liveUA, signal: request.signal })
                  const turnResolved = runTurn({
                    origin,
                    cookie: [...jar.values()].join("; "),
                    accessToken: liveSession.accessToken,
                    model: body.model,
                    prompt,
                    userAgent: liveUA,
                    signal: request.signal,
                  })
                  // A session read that rotated the shards keeps the fresh jar.
                  for (;;) {
                    const step = await turnResolved.next()
                    if (step.done) {
                      last = step.value
                      break
                    }
                    const state = step.value
                    if (state.text.length > sent) {
                      const delta = state.text.slice(sent)
                      sent = state.text.length
                      controller.enqueue(encoder.encode(chunk(id, created, body.model, { role: "assistant", content: "" })))
                      controller.enqueue(encoder.encode(chunk(id, created, body.model, { content: delta })))
                    }
                  }
                } catch (error) {
                  failure = error
                }
                if (failure) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: failure.message ?? String(failure), type: "upstream_error" } })}\n\n`))
                  controller.close()
                  return
                }
                controller.enqueue(encoder.encode(chunk(id, created, body.model, {}, finishReason(last?.status))))
                controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                controller.close()
              },
            })

            if (!streaming) {
              const collected = await new Response(stream).text()
              let text = ""
              let finish = "stop"
              for (const line of collected.split("\n")) {
                if (!line.startsWith("data: ")) continue
                const payload = line.slice(6)
                if (payload === "[DONE]") continue
                let frame
                try {
                  frame = JSON.parse(payload)
                } catch {
                  continue
                }
                const choice = frame.choices?.[0]
                if (choice) {
                  text += choice.delta?.content ?? ""
                  if (choice.finish_reason) finish = choice.finish_reason
                }
              }
              return new Response(
                JSON.stringify({
                  id,
                  object: "chat.completion",
                  created,
                  model: body.model,
                  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish }],
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              )
            }
            return new Response(stream, {
              status: 200,
              headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
            })
          },
        }
      },
    },
    async usage() {
      // The web app exposes no machine-readable allowance.
      return { plan: "ChatGPT (web)", windows: [] }
    },
    provider: {
      id: PROVIDER,
      async models(provider) {
        return provider.models
      },
    },
  }
}

// checkCookie asks /api/auth/session whether a cookie header is a live session.
async function checkCookie(origin, cookie) {
  const { session } = await import("./api.mjs")
  const jar = new Map(cookie.split("; ").map((pair) => [pair.slice(0, pair.indexOf("=")), pair]))
  const value = await session(origin, jar)
  return { email: value.user?.email ?? "", name: value.user?.name ?? "" }
}

export default { id: PROVIDER, server }
