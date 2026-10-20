// Identity, models and the site constants this plugin is built on.

const PROVIDER = "chatgpt-web-linux"
const NAME = "ChatGPT (chatgpt.com web)"
const DEFAULT_ORIGIN = "https://chatgpt.com"
const NPM = "@ai-sdk/openai-compatible"

// This machine's Chrome's own client hints. cf_clearance in the cookie jar is
// bound to the User-Agent, so both must come from the same real browser; the
// sign-in stores the UA alongside the cookies and this default is the fallback.
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
const SEC_CH_UA = '"Chromium";v="154", "Google Chrome";v="154"'

const MODELS = [
  { id: "auto", name: "Auto", thinking: false, context: 128_000, output: 32_768 },
  { id: "gpt-5-6", name: "GPT-5.6 Luna", thinking: false, context: 128_000, output: 32_768 },
  { id: "gpt-5-3-mini", name: "GPT-5.3 Mini", thinking: false, context: 128_000, output: 32_768 },
  { id: "gpt-5-6-mini", name: "GPT-5.6 Mini", thinking: false, context: 128_000, output: 32_768 },
  { id: "gpt-6", name: "GPT-6", thinking: false, context: 128_000, output: 32_768 },
  { id: "gpt-6-mini", name: "GPT-6 Mini", thinking: false, context: 128_000, output: 32_768 },
]

const CHAT_PATHS = {
  "/chat/completions": "chat",
}

// Models the account actually has, as /backend-api/models reports. The static
// list above is the offline fallback; the loader refreshes from the site.
function modelOf(model) {
  return {
    name: model.name,
    reasoning: false,
    tool_call: false,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: model.context, output: model.output },
    cost: { input: 0, output: 0 },
  }
}

function configModels() {
  return Object.fromEntries(MODELS.map((model) => [model.id, modelOf(model)]))
}

function accountLabel(cookieHeader) {
  const shard = /__Secure-next-auth\.session-token\.0=([^;]{6})/.exec(cookieHeader ?? "")
  return shard ? `chatgpt.com · ${shard[1]}…` : "chatgpt.com web"
}

export {
  PROVIDER,
  NAME,
  DEFAULT_ORIGIN,
  NPM,
  DEFAULT_USER_AGENT,
  SEC_CH_UA,
  MODELS,
  CHAT_PATHS,
  modelOf,
  configModels,
  accountLabel,
}
