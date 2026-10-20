# magpie-web-chatgpt

**ChatGPT (chatgpt.com 网页版) 的 Magpie 非官方插件** —— 把你已在浏览器里登录的 chatgpt.com 账号接入 [Magpie](https://github.com/yetone/magpie)：读取网页会话 Cookie，按网站自己的协议（sentinel 工作量证明 + conversation SSE 流）发起对话。不需要 Playwright、不需要浏览器自动化，无头 Linux 服务器可用。

**非官方声明**：本项目与 OpenAI、Magpie (yetone) 官方无隶属或合作关系，也未获其授权。"ChatGPT" 及相关名称商标属于各自权利人，此处仅为描述性使用。请完整阅读下方「合规与风险」，仅使用你本人拥有并已登录的账号。

## 功能

- **供应商 id**：`chatgpt-web-linux`；模型目录从 `/backend-api/models` 动态读取（`auto` / `gpt-5-6` / `gpt-5-3-mini` / `gpt-5-6-mini` / `gpt-6` / `gpt-6-mini` / …，以账号实际目录为准），离线时回落到内置表。
- **OpenAI 兼容**：`npm: @ai-sdk/openai-compatible`，Magpie 网关（`/v1/chat/completions`）直接路由；流式与非流式都支持。
- **每轮对话独立**：所有请求带 `history_and_training_disabled: true`，**不在账号的 chatgpt.com 历史里留痕**；历史由客户端（Magpie）持有并整段标注后随轮发送。
- **sentinel 工作量证明**（`src/proof.mjs`）：网站网页客户端自己执行的 SHA3-512 PoW 的独立实现（`sha3_512(seed + base64(json(config)))` 的十六进制前缀按难度字符串比较），无第三方依赖，`node:crypto` 原生完成。
- **TLS 指纹适配**：Magpie 插件宿主是 Bun（BoringSSL 指纹会被 chatgpt.com 的 Cloudflare 挑战 403）；插件在 Bun 下自动经一次性 `node` 子进程（`scripts/fetch-bridge.mjs`，OpenSSL 指纹）中继所有站点请求，非 Bun 运行时直接 fetch。含代理透传（`HTTPS_PROXY` 等）与断连重试。

## 安装

```sh
# ① 本地目录安装（推荐，目录保持固定）
magpie plugin add /path/to/magpie-web-chatgpt

# ② 从 GitHub 安装（若已发布）
magpie plugin add github:<owner>/magpie-web-chatgpt
```

安装后 `magpie plugin list` 应出现 `chatgpt-web-linux (ChatGPT (chatgpt.com web), N models)`。

## 登录（两种方式）

```sh
magpie plugin login chatgpt-web-linux api      # 方式①：粘贴 Cookie（无头服务器用这个）
magpie plugin login chatgpt-web-linux oauth    # 方式②：读本机浏览器
```

### 方式① 粘贴 Cookie（推荐，无头服务器可用）

1. 在**任一已登录 chatgpt.com 的浏览器**（本机或你的笔记本）打开 chatgpt.com，按 F12 → Network；
2. 随便找一个 `chatgpt.com/backend-api/*` 的请求，右键 → Copy → **Copy request headers**（或只复制其中的 `Cookie:` 头）；
3. 记下**该浏览器的 User-Agent**（Console 里输入 `navigator.userAgent` 回车）——`cf_clearance` Cookie 与 UA 绑定，插件需要同一 UA；
4. 运行 `magpie plugin login chatgpt-web-linux api`，把完整 Cookie 头（`__Secure-next-auth.session-token.0=…; __Secure-next-auth.session-token.1=…; cf_clearance=…; oai-did=…; …`）粘贴进去。首次真实请求时插件会校验会话有效性。

CLI 的交互式登录器对空输入即接受、把校验留给首次请求；若想手工落盘，把 Cookie 写进 Magpie 配置目录的 `plugin-auth.json`（先备份）：

```json
"chatgpt-web-linux": { "type": "api", "key": "<完整 Cookie 头>", "metadata": { "source": "pasted" } }
```

UA 绑定：`cf_clearance` 只对签发它的那个 UA 有效。本插件的默认 UA 是 `Mozilla/5.0 (X11; Linux x86_64) … Chrome/154.0.0.0 Safari/537.36`（与开发机的 Chrome 154 一致）；如果你粘贴的 Cookie 来自别的浏览器/平台，请在 `plugin-auth.json` 的 `metadata.userAgent` 里写上那个浏览器的 UA。

### 方式② 读取本机浏览器（Linux 桌面）

`magpie plugin login chatgpt-web-linux oauth` 自动从本机 Chromium 系浏览器（google-chrome / chromium / Brave / Edge / Vivaldi）的 profile 解密 chatgpt.com 的 Cookie 并验证。解密走 GNOME keyring（Secret Service D-Bus）的 "Chrome Safe Storage"，需系统装有 `python3 + python3-dbus + python3-cryptography`（Debian/Ubuntu：`sudo apt install python3-dbus python3-cryptography`）。只读不写，profile 数据库以副本打开。

**Cookie 有效期**：session-token 分片约 90 天（Max-Age 7776000），插件会跟随 `/api/auth/session` 的 Set-Cookie 轮换；`cf_clearance` 随 UA 与 IP 变化可能更早失效——失效时重新粘贴一份即可。

## 实测验证（2026-10-20，zkyd 主机）

**请求**：

```sh
curl -sS -X POST http://127.0.0.1:11006/v1/chat/completions \
  -H "Authorization: Bearer sk-magpie-key-…" \
  -H "Content-Type: application/json" \
  --data '{"model":"chatgpt-web-linux/auto","stream":false,
           "messages":[{"role":"user","content":"Reply with exactly: GATEWAY-PONG"}]}'
```

**响应**：

```json
{"choices":[{"finish_reason":"stop","index":0,
             "message":{"content":"GATEWAY-PONG","role":"assistant"}}],
 "created":1792493599,"id":"chatcmpl-fd2b8ffd-d96","model":"auto",
 "object":"chat.completion","usage":{…}}
```

**流式**（`"stream": true`，`chatgpt-web-linux/gpt-6`，中文提问"用一句话介绍你自己"）逐块返回：

```
"content":"我是 GPT-"  "content":"6，一个能够理解和生成多种语言、"
"content":"协助你学习、写作、编程、分析问题，并陪"  "content":"你探索新想法的 AI"
```

## 冒烟测试

```sh
# 网关模型目录里应出现 chatgpt-web-linux/*
curl -s http://127.0.0.1:11006/v1/models -H "Authorization: Bearer sk-magpie-key-…" | \
  python3 -c "import json,sys; print([m['id'] for m in json.load(sys.stdin)['data'] if 'chatgpt-web-linux' in m['id']])"

# 真实对话
curl -sS -X POST http://127.0.0.1:11006/v1/chat/completions \
  -H "Authorization: Bearer sk-magpie-key-…" -H "Content-Type: application/json" \
  --data '{"model":"chatgpt-web-linux/auto","stream":false,"messages":[{"role":"user","content":"ping"}]}'

# 插件本地自检（不经 magpie，需真实 Cookie 在 plugin-auth.json 或环境）
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node scripts/check.mjs
```

## 网络与代理

chatgpt.com 在部分网络不可直连。插件在 Bun 桥接层向子进程透传宿主进程的代理环境变量（`HTTPS_PROXY` / `HTTP_PROXY` / `NODE_USE_ENV_PROXY`）；确保 Magpie 服务的 env（如 `/home/uict/data1/app/magpie/magpie.env`）里已配好代理。

## 目录结构

```
src/
  index.mjs          入口（导出 server 与 _internal）
  config.mjs         供应商 id、模型、站点常量
  plugin.mjs         server 钩子装配（config / chat.headers / auth / loader）
  api.mjs            站点 HTTP：浏览器头、会话、模型目录、TLS 桥（siteFetch / siteFetchStream）
  proof.mjs          sentinel 工作量证明（SHA3-512，node:crypto）
  turn.mjs           单轮：requirements → proof → conversation SSE
  openai.mjs         OpenAI 兼容分片与消息扁平化
  browser-cookie.mjs Linux 浏览器 profile 登录（方式②）
scripts/
  fetch-bridge.mjs   Bun 宿主下的一次性 node 中继（含流式 JSON-lines 模式）
  dump-browser-cookies.py  Chrome keyring cookie 解密（v11 + SHA256(域) 前缀）
  check.mjs          本地自检（不经 magpie）
```

## 限制

- 每轮都是独立对话（不留痕），没有 ChatGPT 侧的连续会话；工具调用、图片输入、联网搜索开关未实现（网页协议无 tools 字段）。
- 模型能力标注统一为 `reasoning: false, tool_call: false`（保守），实际模型可能更强。
- 账号配额/限流由 chatgpt.com 侧控制；429/403 会以错误消息透传。
- 网页接口随时可能变更，不承诺兼容性。

## 合规与风险

- 本插件重放你本人网页会话调用 chatgpt.com 的内部接口，**不是 OpenAI 官方 API**；账号授权不等于接口自动化使用授权，请自行核实 OpenAI 服务条款对自动化访问的规定。
- PoW 是网页客户端自身同样执行的计算，本项目是其公开协议的独立实现；不绕过验证码、不绕过 Cloudflare 人机校验（`cf_clearance` 必须来自真实浏览器会话）。
- Cookie 是敏感登录凭证：不要公开、提交到仓库或分享 `plugin-auth.json`。对话内容会发送至 OpenAI。
- 接口变更、账号受限、服务中断等风险由使用者自行评估。

## 许可

MIT
