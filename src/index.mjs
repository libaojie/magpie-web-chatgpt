// ChatGPT (chatgpt.com web) as an OpenCode/magpie provider plugin.
//
// The account is the one the user is already signed in to in their browser:
// chatgpt.com keeps its session in cookies (__Secure-next-auth.session-token
// shards), so the sign-in reads that cookie jar out of a signed-in profile (or
// takes it pasted) and replays it. Requests go to the site's own backend-api,
// which the browser and this plugin both use:
//
//   POST /backend-api/sentinel/chat-requirements   the turn's gate: requirements token + proof-of-work
//   POST /backend-api/conversation                 the turn, answered as SSE
//   GET  /backend-api/models                       the account's catalogue
//   GET  /api/auth/session                         the access token behind the cookies
//
// The proof-of-work (src/proof.mjs) is what the web client itself computes:
// sha3_512(seed + base64(json(config))) under the difficulty the site names.

import { PROVIDER } from "./config.mjs"
import { server } from "./plugin.mjs"

export { server }

export default { id: PROVIDER, server }

// for tests
export const _internal = {
  config: () => import("./config.mjs"),
  proof: () => import("./proof.mjs"),
  api: () => import("./api.mjs"),
  turn: () => import("./turn.mjs"),
  openai: () => import("./openai.mjs"),
}
