# dsh-llm-web-bridge — Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中
- 更多站点适配器（Claude、Kimi、DeepSeek 等）
- 会话导出/导入
- 多账号轮换
- CI 自动化测试

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
