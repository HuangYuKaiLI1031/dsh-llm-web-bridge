# dsh-llm-web-bridge — Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中（Roadmap）
- 更多站点适配器：Claude、Kimi、DeepSeek 等
- 会话导出 / 导入（备份与迁移）
- 多账号轮换
- ChatGPT Plus 模型选择器 / 思考强度（Low/Medium/High）实测适配（免费版已支持"思考"开关）
- 多会话并发（当前为单活跃站点，省资源设计）

## [0.2.0] - 2026-08-19

### 新增
- **`verify` 内置角色**：事实核查员，区分"可确认/需查证/无法验证"，给结论置信度与验证途径
- **ChatGPT "思考"模式开关**：面板一键切换思考模式（免费版已实测：点"思考"pill，`aria-pressed` 状态同步）
- **每站点命名会话**（P1-6）：会话列表 / 新建 / 切换 / 删除，面板下拉 + 配置区管理
- **Token 计量**（P1-7）：每次往返估算 tokens（CJK 感知），按站点累计，状态栏 + API 展示
- **自定义站点面板配置**（P1-8）：URL + 输入框/回复选择器直接配置，激活 generic 能力
- **长任务进度反馈**（P1-9）：发送中/生成中… 面板动画提示（daemon 写 progress 文件）
- **UI 驱动 / 调试能力**：daemon 新增 `click` / `eval` / `get-dom` / `reload-config` action
- **更灵活的认证路径**：`DSH_BRIDGE_BASE` 等全部路径可由 config 或 env 配置（去本地化）

### 优化
- **回复等待超时 60s → 180s 可配置**（`DSH_BRIDGE_REPLY_TIMEOUT` / `config.replyTimeout`），长推理不再误报
- **回复截断 3000 → 8000 可配置**（`DSH_BRIDGE_MAX_REPLY_LEN` / `config.maxReplyLen`），深度讨论不丢内容
- **结束符机制健壮化**：不再只认 marker——"消息连续 N 次稳定"即判定完成（`DSH_BRIDGE_STABLE_POLLS`）
- **命令串行化**：修复多并发 consult（面板轮询 vs 工具调用）互相覆盖 command/reply 文件的竞态
- **health-status 非阻塞**：改为直接读 daemon 持续更新的健康文件，面板轮询不再抢占命令
- **长回复期间 daemon 保持响应**：健康探测嵌入回复等待循环
- **status API 瘦身**：默认只回最近 10 条 + 摘要 + token 用量（原 111KB/3s → 约 2KB/3s）

### 修复
- 并发 consult 竞态导致命令被覆盖、调用超时（面板 health-status 轮询覆盖 screenshot 命令）
- daemon 忙时无法响应 health 探测

### 安全
- 依旧：Cookie 仅存本机数据目录，API 仅限 localhost

## [0.1.0] - 2026-08-17

### 新增
- `consult_llm` 全局工具：agent 可自动调用网页 LLM（独立审核/代码审查/翻译/红队/推理/润色）
- 多站点适配器架构：Gemini / ChatGPT / 豆包 / 通用（自定义选择器）
- 自定义角色：用户可保存任意角色人设（`custom_roles.json`），发送时 `role` 引用
- 文字对话记录为主界面 + 实时截图按需开启
- 单活跃站点（一次只在线一个 LLM），手动切换省资源
- 会话健康检测：定期探测登录态，实时反映页面状态，失效面板提示 + 一键重连
- Cookie 自动重载：粘贴 Cookie 后自动重建站点 context，无需手动重启
- 结束符协议：提示词要求模型输出"回答完成，请检查。"，可靠取回完整回复
- 有头模式（Xvfb 虚拟显示）：显著降低 Cloudflare/验证码拦截
- 站点自定义命名、智能 Cookie 解析（5 种格式）
- 导航重试 + 发送失败检测（消息计数）

### 修复
- 发送失败时误把旧回复当新回复返回（增加发送前消息计数检测）
- 站点切换后命令文件残留导致后续命令卡住
- 健康检测数据滞后（显示切换前站点状态）
- 同站点无法强制重建 context（新增 `reconnect: true`）

### 安全
- Cookie 仅存本机数据目录，API 仅限 localhost
- README 声明自动化使用网页 LLM 的账号风险
