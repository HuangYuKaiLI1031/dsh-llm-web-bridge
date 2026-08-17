# dsh-web-llm-bridge

![License](https://img.shields.io/badge/license-MIT-green)
![Version](https://img.shields.io/npm/v/dsh-web-llm-bridge)

**DSH（DeepSeek Harness）Web 插件**：把第三方**网页版**大模型（Gemini、ChatGPT、豆包、自定义站点）接入你的 agent 工作流——通过真实浏览器驱动，而非 API。

- **`consult_llm` 全局工具**：agent 需要独立审核、第二意见、代码审查、翻译、红队挑战时自动调用网页 LLM
- **多站点适配器**：Gemini / ChatGPT / 豆包 / 通用（新增站点 = 写一个适配器文件）
- **文字对话记录为主** + 实时画面按需开启
- **单活跃站点**：一次只在线一个 LLM，手动切换，省资源
- **会话健康检测**：定期探测登录态，失效时面板提示 + 一键重连

## 特性

| 能力 | 说明 |
|---|---|
| 多站点 | `gemini` / `chatgpt` / `doubao` / `generic`（自定义选择器） |
| 双显示模式 | 文字对话记录（默认）\| 实时截图（按需） |
| 持续会话 | 同站点内连续消息延续同一对话；`fresh:true` 才新建 |
| 站点命名 | 面板可给每个站点自定义显示名 |
| 认证多格式 | 智能解析 JSON / DevTools 表格 / Netscape / cookie 字符串 |
| 反检测 | 有头模式（Xvfb）+ 真实登录态复用 + 导航重试 |
| 健康检测 | 会话失效自动探测 + 面板状态栏 + 重新连接 |
| 结束符机制 | 提示词要求模型输出"回答完成，请检查。"，可靠取回完整回复 |

## 安装

```bash
# 1. 运行时依赖
python3 -m venv <BASE>/.venv
<BASE>/.venv/bin/pip install playwright
PLAYWRIGHT_BROWSERS_PATH=<BASE>/.pw-browsers <BASE>/.venv/bin/playwright install chromium

# 2. 中文字体（可选，否则中文显示方块）
#    下载 Noto Sans SC 到 <BASE>/.fonts/，配置 FONTCONFIG_FILE

# 3. Xvfb（可选，有头模式，绕过 Cloudflare/验证码更有效）
#    conda: conda create -n xvfb-clean -c conda-forge xvfb  或系统包管理器安装

# 4. 安装插件到 DSH web profile
cd ~/.dsh/profiles/web
dsh plugin --profile web add dsh-web-llm-bridge
# 或本地: dsh plugin --profile web add "link:<本插件路径>"
# 重启 dsh web
```

## 配置

所有运行时路径通过环境变量或插件 config 配置：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BRIDGE_BASE` | 插件数据目录 | 运行时数据（cookie/日志/截图） |
| `DSH_BRIDGE_DAEMON` | `<BASE>/daemon/browser_daemon_webllm.py` | 守护进程路径 |
| `DSH_BRIDGE_PYTHON` | `<BASE>/.venv/bin/python` | Python 解释器 |
| `DSH_BRIDGE_BROWSERS` | `<BASE>/.pw-browsers` | Playwright 浏览器 |
| `DSH_BRIDGE_FONTCONFIG` | `<BASE>/fonts.conf` | 中文字体配置 |
| `DSH_BRIDGE_XVFB` | `xvfb`（PATH） | Xvfb 二进制 |

> 也可在 `cordis.patch.yml` 的插件 `config` 中设置 `headless` / `display` / `xvfbBin` / `daemonPath` 等。

## 认证（每站点独立）

面板 ⚙️ 配置 → 选站点 → 粘贴 Cookie（5 种格式自动识别）。文件：`<BASE>/cookies_<site>.json`。

### ⚠️ ChatGPT / Cloudflare

必须包含 `cf_clearance` 和 `__cf_bm`（在你的真实浏览器通过 challenge 后由 Cloudflare 种下）：

1. 登录 chatgpt.com → F12 → Application → Cookies → 复制全部
2. 粘贴到面板 → 保存 → **自动重载**（插件自动重建该站点浏览器 context，无需手动重启）
3. `cf_clearance` 绑定浏览器指纹，跨环境可能失效 → 更新 cookie 即可自动生效

### ⚠️ 豆包

豆包（doubao.com）有字节验证码风控（`rmc.bytedance.com` 滑块），**headless 无法通过**；有头模式下可能静默拒绝。适配器已内置，可用性取决于运行环境。

## 使用

**持续会话**：同站点连续发送（不带 `fresh`）延续同一对话——适合"一个项目一个对话持续聊"。

**🎭 自定义角色**：面板 ⚙️ → 输入角色名 + 提示词 → 保存。之后发送时 `role` 填角色名即可。

**示例**：保存 `{name: "国学大师", prompt: "你是精通国学的大师，引经据典，文风典雅"}`，发送 `role: "国学大师"` → 模型按国学大师风格回答。内置 6 角色（review / code-review / translator / adversary / reasoner / editor）也可直接使用。

**agent 自动调用**：`consult_llm` 工具参数：

| 参数 | 说明 |
|---|---|
| `question` | 问题（必填） |
| `provider` | `gemini`(默认) / `chatgpt` / `doubao` / `generic` |
| `role` | 内置或**自定义角色名**（留空=自由对话） |
| `context` | 待审内容（可选） |
| `fresh` | `true`=新建对话 |

## API

| 路由 | 说明 |
|---|---|
| `GET /dsh-llm-bridge/api?action=sites` | 站点列表 + 当前站点 |
| `POST ...switch-site` | 切换站点 |
| `GET ...status` | 文字记录 + 状态 |
| `GET ...list-roles` | 内置 + 自定义角色列表 |
| `POST ...save-role` | 保存自定义角色 `{name, prompt}` |
| `POST ...delete-role` | 删除自定义角色 `{name}` |
| `GET ...auth-status` / `POST ...configure-cookie` / `POST ...clear-auth` | 认证管理 |
| `GET ...health-status` / `POST ...reconnect` | 会话健康检测 + 重连 |
| `GET ...daemon-status` / `POST ...daemon-start/stop` | 守护进程管理 |
| `POST ...send` | 发送消息 |
| `POST ...action` | 操作（new-chat / stop / screenshot） |
| `POST ...rename-site` | 站点命名 |
| `GET /dsh-llm-bridge/frame.jpg?site=xx` | 实时截图（按需） |

## 站点适配器

```
lib/adapters/
├── index.js     # 注册表
├── gemini.js    # Gemini（参考实现）
├── chatgpt.js   # ChatGPT（CF 注意事项）
├── doubao.js    # 豆包（验证码限制）
└── generic.js   # 通用（可配置选择器）
```

每个适配器：`findEditor` / `send` / `lastMessage` / `newChat` / `detectLogin` / `stop`。

## 文件布局

```
dsh-web-llm-bridge/
├── package.json / cordis.patch.yml / LICENSE / README.md
├── lib/
│   ├── index.js       # Host：API + consult_llm + 守护管理 + Xvfb
│   ├── client.js      # Client：面板（记录/实时/状态栏/配置）
│   └── adapters/      # 站点适配器
└── daemon/
    └── browser_daemon_webllm.py  # 浏览器守护（headless/headed）
```

## 常见问题

- **ChatGPT 卡"请稍候"**：Cloudflare challenge，等几秒或重试导航；确认 cookie 含 `cf_clearance`；有头模式（Xvfb）显著改善。
- **改了代码不生效**：正式插件启动时加载，改后重启 DSH。
- **守护状态误判**：外部杀进程后先"⏹ 停止"再"▶ 启动"。
- **中文方块**：装中文字体 + `FONTCONFIG_FILE`。

## 安全说明

- Cookie 仅存本机 `<BASE>/`，不上传任何第三方；API 仅限 localhost。
- 自动化访问网页 LLM 请遵守各站服务条款；建议使用临时账号。
- 本项目仅供学习研究；使用者自行承担账号风险。

## License

MIT
