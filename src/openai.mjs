// The OpenAI-shaped answer: magpie's SDK talks OpenAI chat completions to a
// plugin's fetch, so the conversation SSE is translated into that shape — one
// choice, delta.content deltas, a finish_reason and usage.

const encoder = new TextEncoder()

function chunk(id, created, model, delta, finishReason) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  })}\n\n`
}

// messageSignature is one message's identity, as the continuation anchor: the
// agent may rewrite its history between requests, so where the conversation
// continues is found by locating the last message the previous request ended with.
function messageSignature(message) {
  const content = typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content)
      ? JSON.stringify(message.content)
      : ""
  return JSON.stringify([message?.role ?? "", content, message?.tool_call_id ?? ""])
}

// messagesToPrompt flattens OpenAI messages into ChatGPT's one text box, the
// way the web page's one input holds a conversation. ChatGPT's wire keeps
// whole conversations server-side, but this plugin runs every turn as a fresh
// temporary conversation with history_and_training_disabled, so the whole
// labelled history rides each turn — no server chat is created that the
// account's history would show.
function messagesToPrompt(messages, { system = true } = {}) {
  const parts = []
  let spoke = false
  for (const message of messages ?? []) {
    const role = message?.role
    const text = typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
        : ""
    if (!text) continue
    if (role === "system") {
      if (system) parts.push(`[System]\n${text}`)
      continue
    }
    if (role === "assistant") {
      parts.push(`[Assistant]\n${text}`)
      continue
    }
    if (role === "tool") {
      parts.push(`[Tool result]\n${text}`)
      continue
    }
    // user
    if (spoke) parts.push(`[User]\n${text}`)
    else parts.push(text)
    spoke = true
  }
  return parts.join("\n\n")
}

// finishReason maps the stream's end state onto OpenAI's.
function finishReason(status) {
  switch (status) {
    case "finished_successfully":
      return "stop"
    case "finish_reason:length":
    case "max_tokens":
      return "length"
    case "content_filter":
      return "content_filter"
    default:
      return "stop"
  }
}

export { encoder, chunk, finishReason, messagesToPrompt, messageSignature }
