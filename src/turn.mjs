// One turn against the conversation endpoint: the sentinel requirements, the
// proof token, and the SSE reply read into {text, status, conversationId,
// messageId} as deltas arrive.

import { proofToken } from "./proof.mjs"
import { browserHeaders, applySetCookie, siteFetch, siteFetchStream } from "./api.mjs"

// iterSse reads `data:` JSON frames off a fetch body.
async function* iterSse(body) {
  const decoder = new TextDecoder()
  let buffer = ""
  const pending = []
  for await (const piece of body) {
    buffer += decoder.decode(piece, { stream: true })
    let index
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      if (!line) {
        if (pending.length) {
          const data = pending.join("\n")
          pending.length = 0
          if (data.trim() !== "[DONE]") {
            try {
              yield JSON.parse(data)
            } catch {
              // a frame that isn't JSON is the site's business
            }
          }
        }
        continue
      }
      if (line.startsWith("data: ")) pending.push(line.slice(6))
    }
  }
  if (pending.length) {
    try {
      yield JSON.parse(pending.join("\n"))
    } catch {
      // ignore a trailing partial frame
    }
  }
}

// requirements asks the sentinel for this turn's gate: the requirements token
// and, when the persona demands one, a proof-of-work seed and difficulty.
async function requirements({ origin, jar, accessToken, userAgent, signal }) {
  // the call itself carries a throwaway proof (difficulty "0" accepts at once)
  const warm = proofToken(String(Math.random()), "0", { userAgent })
  const response = await siteFetch(`${origin}/backend-api/sentinel/chat-requirements`, {
    method: "POST",
    headers: browserHeaders(origin, { cookie: jar, accessToken, userAgent, extra: { "content-type": "application/json" } }),
    body: JSON.stringify(warm ? { p: warm } : {}),
    signal: signal ?? AbortSignal.timeout(45_000),
  })
  if (!response.ok) {
    throw new Error(`ChatGPT chat-requirements: HTTP ${response.status}`)
  }
  const value = await response.json()
  if (typeof value?.token !== "string" || !value.token) throw new Error("ChatGPT chat-requirements: no token")
  return value
}

// runTurn streams one conversation turn; yields {text, reasoning} state and
// returns {conversationId, messageId, status}.
async function* runTurn({ origin, cookie, accessToken, model, prompt, userAgent, signal }) {
  const jar = new Map(cookie.split("; ").map((pair) => [pair.slice(0, pair.indexOf("=")), pair]))
  const jarString = () => [...jar.values()].join("; ")

  const req = await requirements({ origin, jar: jarString(), accessToken, userAgent, signal })
  let proof = null
  if (req.proofofwork?.required) {
    proof = proofToken(req.proofofwork.seed, req.proofofwork.difficulty, { userAgent })
    if (!proof) throw new Error("ChatGPT proof-of-work: no answer found within the shell budget")
  }

  const headers = browserHeaders(origin, {
    cookie: jarString(),
    accessToken,
    userAgent,
    extra: {
      accept: "text/event-stream",
      "content-type": "application/json",
      "openai-sentinel-chat-requirements-token": req.token,
      ...(proof ? { "openai-sentinel-proof-token": proof } : {}),
      ...(req.turnstile?.token ? { "openai-sentinel-turnstile-token": req.turnstile.token } : {}),
    },
  })
  const response = await siteFetchStream(`${origin}/backend-api/conversation`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      action: "next",
      conversation_mode: { kind: "primary_assistant" },
      messages: [{ id: crypto.randomUUID(), author: { role: "user" }, content: { content_type: "text", parts: [prompt] } }],
      model: model ?? "auto",
      parent_message_id: crypto.randomUUID(),
      history_and_training_disabled: true,
      websocket_request_id: crypto.randomUUID(),
      force_use_sse: true,
    }),
  })
  applySetCookie(jar, response.headers.getSetCookie?.() ?? [], origin)
  if (response.status === 401 || response.status === 403) {
    const detail = await response.text().catch(() => "")
    const error = new Error(`ChatGPT conversation refused (HTTP ${response.status}): ${detail.slice(0, 200)}`)
    error.signIn = response.status === 401 ? "expired" : undefined
    throw error
  }
  if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const detail = await response.text().catch(() => "")
    throw new Error(`ChatGPT conversation: HTTP ${response.status} ${detail.slice(0, 200)}`)
  }

  const state = { text: "", reasoning: "", conversationId: null, messageId: null, status: null }
  for await (const frame of iterSse(response.body)) {
    if (frame?.type === "error" || frame?.detail) {
      throw new Error(`ChatGPT conversation error: ${JSON.stringify(frame).slice(0, 200)}`)
    }
    const message = frame?.message
    if (message && message.author?.role === "assistant") {
      state.conversationId = frame.conversation_id ?? state.conversationId
      state.messageId = message.id ?? state.messageId
      if (message.status) state.status = message.status
      if (message.content?.content_type === "text" && Array.isArray(message.content.parts)) {
        const text = message.content.parts.filter((part) => typeof part === "string").join("")
        if (text.length > state.text.length) {
          state.text = text
          yield state
        }
      }
      if (message.metadata?.model_slug) state.model = message.metadata.model_slug
    }
    if (frame?.type === "moderation_message") state.moderation = true
  }
  return state
}

export { runTurn, iterSse, requirements }
