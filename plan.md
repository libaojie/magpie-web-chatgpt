# plan.md — magpie-web-chatgpt 方案

## 目标
把 ChatGPT 网页版（chatgpt.com web 登录态）接入 Magpie 网关（11006，OpenAI 兼容）。

## A / B 两个参考的差异

| | A: magpie-chatgpt-web | B: magpie-deepseek-web-auth |
|---|---|---|
| 思路 | playwright 驱动 Chrome：登录用可见窗口，会话轮次抓 DOM 快照（500ms 轮询）+ 尽力 SSE | 纯 HTTP：读浏览器/粘贴的 web 会话令牌，重放站点自有 API（会话+PoW+SSE 补丁流） |
| 运行依赖 | Chrome + playwright-core（重） | 无（零依赖，node:crypto 就够） |
| 无头服务器 | 差（登录必须可见窗口；DOM 抓取脆弱） | 好（无需浏览器在位） |
| 实测状态 | README 自述：sign-in 验证过，**完整 live turn 从未跑通**（被持久验证挑战挡住） | 已实测跑通 |
| wire | 伪装 @ai-sdk/anthropic（Messages 协议翻译层） | @ai-sdk/openai-compatible（天然对齐） |
| 平台耦合 | 默认 Windows（PowerShell 安装示例、win32 路径、named pipe 锁、Windows UA），也有 darwin/linux 分支 | 三平台分支齐全（Linux 覆盖良好） |

## 本插件的技术选型（B 的架构 + A 的 ChatGPT 协议知识）
- **登录态 = chatgpt.com 的 Cookie**（`__Secure-next-auth.session-token.0/.1` 分片、`oai-did`、`cf_clearance` 等），不是 localStorage 令牌（ChatGPT 会话在 Cookie，B 的 leveldb 扫法不适用，登录方式要重做）。
- 登录方式（面向无头 Linux 服务器）：
  1. **粘贴 Cookie**（推荐）：在任一已登录机器的 chatgpt.com，DevTools 复制请求的 Cookie 头（或 Network 里任一 /backend-api 请求的 Cookie）粘给插件；
  2. **本地 Chrome profile 读取**（Linux 桌面可用）：解密本机 Chromium 系 profile 的 Cookies DB（v10 peanuts / v11 keyring）；
  3. **远程登录**：插件在网关侧起一个一次性本地登录页（127.0.0.1），用户 SSH 端口转发后在任何浏览器完成登录，回调收集 Cookie（作为方式 1 的引导页）。
  - 校验：用 Cookie 调 `GET /api/auth/session` 拿 `accessToken`，成功才存。
- **会话轮次 = 重放 backend-api**（A 的 ReadClient 证实了这些端点）：
  - `GET /backend-api/models` → 模型目录（60s 缓存）
  - `GET /api/auth/session` → accessToken（Cookie 自动轮换跟随，A 的 session() 逻辑）
  - `POST /backend-api/sentinel/chat-requirements` → requirements token（+按需 proof token）
  - `POST /backend-api/conversation` → SSE，解析成 OpenAI chat.completion.chunk；临时聊天 `conversation_mode.kind=temporary_chat`，不在账号历史留痕
  - 云端风控：403 + `cf-mitigated: challenge` → 分类为 verification/expired/cooldown 错误（沿用 A 的分类）
- **OpenAI 兼容层**：`@ai-sdk/openai-compatible`（B 同款，天然对齐网关 11006）；连续对话沿用 B 的 session 续接思路（conversation_id + parent_message_id）。
- **平台适配（Windows→Linux）**：无 named pipe / 无 PowerShell / UA 用本机 Linux Chrome 的真实 UA（cf_clearance 绑定 UA）；路径全按 XDG；不捆绑浏览器。

## 与已装插件的共存
本机 magpie 已装参考 A（provider id `chatgpt-web`，不可用/未跑通）。本插件命名 `magpie-web-chatgpt`，**provider id 取 `chatgpt-web-linux`**，避免与已装注册冲突；README 说明可用 `magpie plugin rm magpie-chatgpt-web` 移除旧参考。

## 里程碑
1. plan.md（本文件）
2. 登录态实验：从本机 Chrome profile 提出 Cookie（CDP headless 副本法），curl 验证 /api/auth/session → models → sentinel → conversation
3. 插件实现（src/：config / auth / chatgpt api / sentinel proof / sse→openai / plugin 装配）
4. `magpie plugin add <path>` 安装 + 登录 + 网关冒烟（curl 11006）
5. README.md（中文）+ dev-log 收尾
