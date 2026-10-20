# 任务：开发 Magpie 插件 magpie-web-chatgpt（ChatGPT 网页版接入 Magpie）

> 执行者：Claude Code @ zkyd（10.3.1.104）
> 工作目录：/home/uict/data2/code/tool/magpie-web-chatgpt（本目录）
> 监督者：Hermes Agent（每 10 分钟核对磁盘落盘进度）

## 1. 核心目标

开发一个 Magpie 插件（magpie-web-chatgpt）：把 **ChatGPT 网页版**（chatgpt.com 的 web 账号登录态）作为 LLM 供应商接入 Magpie 网关。
用户通过插件完成 ChatGPT web 账号登录后，Magpie 的 OpenAI 兼容网关（本机 11006 端口）即可把 chat/completions 请求路由到该 ChatGPT web 账号并返回模型回复。

## 2. 开发规范（必读，先读再动手）

- Magpie 插件开发规范：https://usemagpie.ai/docs/zh/plugins
- 按规范的插件目录结构、接口与注册方式实现；不确定的 CLI 子命令用 `magpie --help`、`magpie plugin --help` 自查
  （magpie 二进制：/home/uict/.local/bin/magpie v0.1.1290；运行 env 参考 /home/uict/data1/app/magpie/magpie.env）

## 3. 参考实现

| 参考 | 说明 | 注意 |
|---|---|---|
| https://github.com/guanwenpeng2001-bot/magpie-chatgpt-web | 最贴近目标：magpie 插件接入 ChatGPT 网页版 | **原为 Windows 平台，必须适配 Linux**：逐一识别平台相关逻辑（路径、浏览器/签名、字符编码、换行）并改造 |
| https://github.com/volcanicll/magpie-deepseek-web-auth | DeepSeek 页面 web-auth 代理，**已验证跑通** | 同类 web-auth 思路，其登录态处理、代理转发流程可复用参考 |

## 4. 目标环境（zkyd = 10.3.1.104，Linux，uict 用户）

| 项 | 值 |
|---|---|
| Magpie | 宿主原生部署：/home/uict/.local/bin/magpie v0.1.1290，systemd `magpie.service` |
| API 网关 | 11006（OpenAI 兼容，冒烟：`curl http://127.0.0.1:11006/v1/models`，200/401=正常） |
| Web 管理 | 11007（`?k=171c01cb2cb56423`） |
| 配置目录 | XDG_CONFIG_HOME=/home/uict/data1/app/magpie/config（程序子目录 config/magpie/：logins.json、caller-keys.json 等） |
| 代理 | mihomo 127.0.0.1:7897。访问外网先导出：`export HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 ALL_PROXY=http://127.0.0.1:7897` |
| Node | /home/uict/.nvm/versions/node/v22.23.3/bin（node v22.23.3 + npm/npx，不在默认 PATH，需 export PATH） |
| git | 可用 |

## 5. 交付要求

1. **插件源码**：位于本工作目录内，遵循 usemagpie 插件规范，可安装到本机 magpie
2. **README.md（中文）**：功能说明、安装/启用方法、ChatGPT web 账号登录流程（若登录需浏览器交互，给出无头服务器可用的方案，如 remote login/粘贴 cookie，写清楚）、冒烟测试方法
3. **实测验证**：插件装入 magpie 后，用可用的 ChatGPT web 账号完成一次真实 chat 调用（curl POST http://127.0.0.1:11006/v1/chat/completions 指向该供应商），把请求与响应摘录写进 README。若当前无可用 ChatGPT 账号：做到"代码完成 + 验证步骤齐备"，并在 dev-log 中明确标注"实测验证待账号"
4. **dev-log.md**：每个里程碑追加一行（时间 / 做了什么 / 结果 / 下一步），供监督者核对磁盘进度；**有实质进展就立即追加**，不要攒着
5. **plan.md**（可选）：读完规范与两个参考仓库后的简明方案（A 与 B 的差异、Windows→Linux 适配点、技术选型）

## 6. 硬性约束

- **禁止 git commit / push**（须用户单独指令）
- 不修改 magpie 服务端源码；改 magpie 配置前先备份（如 cp logins.json logins.json.bak）
- 全程 Linux；参考 A 中 Windows 专属逻辑必须改造，不允许直接照抄
- 参考仓库可 clone 到本目录 `refs/` 下阅读，不进入交付

## 7. 建议执行顺序（可自调）

1. 通读规范 + 参考仓库 A/B → 落 plan.md
2. git clone 参考仓库到 refs/
3. 实现最小可用版本：复用 ChatGPT web 登录态 → 转发 /v1/chat/completions
4. 安装进 magpie + 冒烟（curl 11006）
5. 中文 README + dev-log 收尾

---
*由 Hermes 整理，2026-10-20*