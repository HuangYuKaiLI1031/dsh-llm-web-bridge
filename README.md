# dsh-llm-web-bridge

[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/dsh-llm-web-bridge.svg)](https://www.npmjs.com/package/dsh-llm-web-bridge)
[![GitHub stars](https://img.shields.io/github/stars/HuangYuKaiLI1031/dsh-llm-web-bridge?style=social)](https://github.com/HuangYuKaiLI1031/dsh-llm-web-bridge)
[![CI](https://github.com/HuangYuKaiLI1031/dsh-llm-web-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/HuangYuKaiLI1031/dsh-llm-web-bridge/actions)
[![Platform](https://img.shields.io/badge/platform-DeepSeek%20Harness-blue.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Web LLMs](https://img.shields.io/badge/web%20LLMs-Gemini%20%7C%20ChatGPT%20%7C%20Doubao-orange.svg)](#站点适配器)
[![Made with](https://img.shields.io/badge/made%20with-Playwright%20%7C%20Xvfb-8A2BE2.svg)](daemon/browser_daemon_webllm.py)

**DSH（DeepSeek Harness）Web 插件**：把第三方**网页版**大模型（Gemini、ChatGPT、豆包、自定义站点）接入你的 agent 工作流——通过真实浏览器驱动，而非 API。

- **`consult_llm` 全局工具**：agent 需要独立审核、第二意见、代码审查、翻译、红队挑战、事实核验时自动调用网页 LLM
- **多站点适配器**：Gemini / ChatGPT / 豆包 / 通用（新增站点 = 写一个适配器文件，或面板直接配置）
- **文字对话记录为主** + 实时画面按需开启
- **单活跃站点**：一次只在线一个 LLM，手动切换，省资源
- **会话健康检测**：定期探测登录态，失效时面板提示 + 一键重连
- **ChatGPT 思考模式**：免费版"思考"开关（已实测）；Plus 模型/思考强度预留
- **命名会话 + Token 计量 + 主动核验规则**：深度参与项目开发

## 特性

| 能力 | 说明 |
|---|---|
| 多站点 | `gemini` / `chatgpt` / `doubao` / `generic`（自定义选择器）+ 面板配置任意站点 |
| 双显示模式 | 文字对话记录（默认）\| 实时截图（按需） |
| 持续会话 | 同站点内连续消息延续同一对话；`fresh:true` 才新建 |
| **命名会话** | 每站点会话列表：新建 / 切换 / 删除，一个项目一个会话可回溯 |
| 站点命名 | 面板可给每个站点自定义显示名 |
| **ChatGPT 思考** | 免费版"思考"模式一键开关（已实测）；Plus 模型/强度预留 |
| **Token 计量** | 每次往返估算 tokens（CJK 感知），按站点累计显示 |
| 认证多格式 | 智能解析 JSON / DevTools 表格 / Netscape / cookie 字符串 |
| 反检测 | 有头模式（Xvfb）+ 真实登录态复用 + 导航重试 |
| 健康检测 | 会话失效自动探测 + 面板状态栏 + 重新连接（非阻塞） |
| **长任务进度** | 发送中/生成中… 面板动画提示 |
| **verify 角色** | 事实核查员：区分可确认/需查证/无法验证，给置信度 |
| 结束符机制 | 提示词要求模型输出"回答完成，请检查。"，消息稳定兜底取回完整回复 |

## 安装

### ⚡ 方式一：一键脚本（推荐）

```bash
# 克隆/进入插件目录后执行：
./scripts/install.sh

# 常用参数：
./scripts/install.sh --base /data/llm-bridge      # 指定数据目录（默认 ~/dsh-web-llm-bridge-data）
./scripts/install.sh --profile web --headless     # 指定 DSH profile、无头模式
./scripts/install.sh --headless                   # 无头模式（不需要 Xvfb）
./scripts/install.sh --help                       # 查看全部参数

# 安装后检查环境：
./scripts/doctor.sh --base /data/llm-bridge       # 诊断必需依赖是否就绪
```

脚本会自动完成：创建 Python 虚拟环境 → 安装 Playwright → 下载 Chromium → 检测 Xvfb/字体 → 注册到 DSH profile → 生成配置。

> **安装后仍需手动做两件事**：重启 DSH web、在面板粘贴 Cookie（见下方「认证」）。

---

### 🔧 方式二：手动安装

#### 1. Python 运行时依赖

```bash
# 创建虚拟环境（<BASE> 是你的数据目录，例如 ~/dsh-web-llm-bridge-data）
mkdir -p <BASE>
python3 -m venv <BASE>/.venv
<BASE>/.venv/bin/pip install playwright

# 下载 Chromium（必须指定 PLAYWRIGHT_BROWSERS_PATH，daemon 会用它）
PLAYWRIGHT_BROWSERS_PATH=<BASE>/.pw-browsers <BASE>/.venv/bin/playwright install chromium
```

> `python3` 需要 3.9+。如果系统没有 `venv`，先 `apt install python3-venv`（Debian/Ubuntu）或 `conda create -n llm-bridge python=3.11`。

#### 2. （可选）中文字体

不装只会导致面板中文显示为方块，不影响功能：

```bash
# Debian/Ubuntu
apt install fonts-noto-cjk
# 或手动下载 Noto Sans SC 到 <BASE>/.fonts/，设置 FONTCONFIG_FILE=<BASE>/fonts.conf
```

#### 3. （可选）Xvfb 虚拟显示

**有头模式**（默认）能显著降低 Cloudflare/验证码拦截率，需要在无显示器的服务器上装 Xvfb：

```bash
# conda（推荐）
conda create -n xvfb-clean -c conda-forge xvfb
# 或 Debian/Ubuntu
apt install xvfb
```

如果选择**无头模式**（`--headless` 或配置 `headless: true`），可以跳过 Xvfb。

#### 4. 把插件注册到 DSH profile

```bash
# 方式 A：用 dsh CLI（推荐，会自动 link）
cd ~/.dsh/profiles/web
dsh plugin --profile web add /path/to/dsh-llm-web-bridge

# 方式 B：手动在 profile 的 package.json 加依赖
cd ~/.dsh/profiles/web
npm pkg set dependencies.dsh-web-llm-bridge="link:/path/to/dsh-llm-web-bridge"
```

#### 5. 配置插件（cordis.patch.yml）

在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- id: web-llm-bridge
  config:
    base: /path/to/data-dir
    pythonBin: /path/to/data-dir/.venv/bin/python
    playwrightBrowsers: /path/to/data-dir/.pw-browsers
    headless: false          # true = 无头模式（可不装 Xvfb）
    display: ':99'           # 有头模式时使用
    # xvfbBin: /path/to/Xvfb # 如不在 PATH
    # fontconfigFile: /path/to/data-dir/fonts.conf
```

> 一键脚本会自动完成第 4、5 步，手动安装请按此配置。

#### 6. 重启 DSH web

```bash
cd ~/.dsh/profiles/web
dsh web
```

---

### 🩺 环境自检

安装后或遇到问题先跑：

```bash
./scripts/doctor.sh                      # 默认数据目录
./scripts/doctor.sh --base /data/llm-bridge   # 指定数据目录
```

它会检查：插件文件、Python 虚拟环境、Playwright 包、Node/语法、Chromium 目录，并提示缺失项的修复命令。

### ❓ 常见问题

| 症状 | 原因 / 解决 |
|---|---|
| 面板一直显示"守护未运行" | 说明 daemon 没起来。先跑 `./scripts/doctor.sh` 看依赖是否缺；确认 `cordis.patch.yml` 里 `pythonBin`/`playwrightBrowsers` 路径正确；重启 DSH web |
| 浏览器启动报 `Executable doesn't exist` | `PLAYWRIGHT_BROWSERS_PATH` 没对。重新执行 `PLAYWRIGHT_BROWSERS_PATH=<BASE>/.pw-browsers <BASE>/.venv/bin/python -m playwright install chromium` |
| ChatGPT 显示"请稍候…" | Cloudflare 拦截，Cookie 失效。在面板 ⚙️ 重新粘贴完整 Cookie（含 `cf_clearance`、`__cf_bm`），保存后自动重载 |
| 豆包发消息取回的是用户自己说的话 | 豆包回复选择器较宽泛，且豆包有字节验证码风控，可用性取决于环境；建议优先用 Gemini/ChatGPT |
| 中文显示为方块 | 未装中文字体。安装 `fonts-noto-cjk` 或配置 `FONTCONFIG_FILE` |
| 有头模式没画面 | 确认 `Xvfb` 已装且 `display: ':99'` 没有被占用；无显示器时用 `--headless` |


## 配置

所有运行时路径通过环境变量或插件 config 配置：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BRIDGE_BASE` | 插件数据目录 | 运行时数据（cookie/日志/截图） |
| `DSH_BRIDGE_DAEMON` | 包内 `daemon/browser_daemon_webllm.py` | 守护进程路径 |
| `DSH_BRIDGE_PYTHON` | `<BASE>/.venv/bin/python` | Python 解释器 |
| `DSH_BRIDGE_BROWSERS` | `<BASE>/.pw-browsers` | Playwright 浏览器 |
| `DSH_BRIDGE_FONTCONFIG` | `<BASE>/fonts.conf` | 中文字体配置 |
| `DSH_BRIDGE_XVFB` | `xvfb`（PATH） | Xvfb 二进制 |
| `DSH_BRIDGE_REPLY_TIMEOUT` | `180` | 回复等待超时（秒），长推理调大 |
| `DSH_BRIDGE_MAX_REPLY_LEN` | `8000` | 回复截断长度（字符） |
| `DSH_BRIDGE_STABLE_POLLS` | `4` | 消息连续 N 次稳定即判定完成 |

> 也可在 `cordis.patch.yml` 的插件 `config` 中设置 `headless` / `display` / `xvfbBin` / `daemonPath` / `replyTimeout` / `maxReplyLen` / `base` 等。

## 认证（每站点独立）

面板 ⚙️ 配置 → 选站点 → 粘贴 Cookie（5 种格式自动识别）。文件：`<BASE>/cookies_<site>.json`。

### ⚠️ ChatGPT / Cloudflare

必须包含 `cf_clearance` 和 `__cf_bm`（在你的真实浏览器通过 challenge 后由 Cloudflare 种下）：

1. 登录 chatgpt.com → F12 → Application → Cookies → 复制全部
2. 粘贴到面板 → 保存 → **自动重载**（插件自动重建该站点浏览器 context，无需手动重启）
3. `cf_clearance` 绑定浏览器指纹，跨环境可能失效 → 更新 cookie 即可自动生效

### ⚠️ 豆包

豆包（doubao.com）有字节验证码风控（`rmc.bytedance.com` 滑块），**headless 无法通过**；有头模式下可能静默拒绝。适配器已内置，可用性取决于运行环境。

## 使用教程

### 1. 面板直接对话（人机交互）

直播面板在输入框上方，默认**文字记录**模式：

- 输入问题 → 回车 → 网页 LLM 回复 → 记录在下方
- 切"📷 实时" → 显示浏览器实时画面（按需开启）
- 站点下拉切换（Gemini / ChatGPT / 豆包 / 自定义）
- 标题栏状态点：绿=会话健康，红=会话异常（点"重新连接"）

**持续会话**：同站点连续发送（不带 `fresh`）延续同一对话——适合"一个项目开一个对话持续聊"。

### 2. 融入 agent 工作流（核心用法）

`consult_llm` 是**全局工具**，注册在 agent 的工具列表里。有两种触发方式：

#### 触发方式 A：agent 自动调用

主 agent 判断需要"外援"时自动调用（独立审核、交叉验证、代码审查等场景）。你**不需要做任何事**——只要在对话里提出需求，agent 会自行决定调用：

```
用户：审查一下 src/utils.ts 的这段代码有没有问题
→ agent 判断需要外援 → 自动调用 consult_llm { ... }
```

#### 触发方式 B：显式指定（推荐，可控性更高）

在对话中**明确要求**使用网页 LLM，并可用 `role` 指定角色。agent 会把你的话翻译成工具调用：

```
用户：用 Gemini 的代码审查角色看看这段代码
→ agent 调用 consult_llm { provider: "gemini", role: "code-review", ... }

用户：让网页 LLM 从红队角度挑战这个结论
→ agent 调用 consult_llm { role: "adversary", ... }
```

#### 指定角色的方式

角色通过 `consult_llm` 的 **`role` 参数**传入，两种途径：

1. **对话里说**（agent 帮你填）：
   - "用**翻译**角色翻译这段" → `role: "translator"`
   - "**红队挑战**一下这个方案" → `role: "adversary"`
2. **工具参数直接写**（如果你直接操作工具）：
   - `role: "code-review"` / `"review"` / `"translator"` / `"adversary"` / `"reasoner"` / `"editor"` / 自定义角色名
   - **留空 = 自由对话**（不套角色）

> 💡 提示：想让 agent **总是**用某个角色，就在需求里说清楚，例如"每次审查代码都用 code-review 角色"。

**代码审查**完整示例：

```
用户：审查一下 src/utils.ts 的这段代码，用代码审查角色
agent → 调用 consult_llm {
  provider: "gemini",
  role: "code-review",
  context: <src/utils.ts 的内容>,
  question: "审查这段代码：检查正确性、边界情况、安全性、可读性和性能"
}
→ Gemini 在真实网页里审查并返回意见 → agent 汇总给你
```

**结论交叉验证**——主 agent 完成分析后，让独立 LLM 复核：

```
agent 完成推理后 → 调用 consult_llm {
  role: "adversary",
  context: <agent 的结论>,
  question: "从红队视角找出这个结论的所有漏洞"
}
```

**翻译**：`role: "translator"` + `context: 原文` → 专业翻译。

### 3. 内置角色详解

| 角色名 | 用途 | 适用场景 |
|---|---|---|
| `review` | 独立审核员：查事实错误、逻辑漏洞、遗漏，给改进建议 | 审查文档/方案/结论（默认角色） |
| `code-review` | 资深代码审查：正确性、边界、安全、可读性、性能，指出 bug 并给修复建议 | 代码审查 |
| `translator` | 专业翻译：保留语气与术语 | 中英互译、文档翻译 |
| `adversary` | 红队对抗：找反驳点、反例、风险、未考虑场景，越尖锐越好 | 结论压测、方案找茬、风险预判 |
| `reasoner` | 严谨推理：逐步推导、显式检查每一步逻辑 | 逻辑题、数学题、复杂分析 |
| `editor` | 资深编辑：润色表达、结构、用词，说明主要改动 | 文章润色、文案改写 |
| `verify` | 事实核查员：区分可确认/需查证/无法验证，给置信度与验证途径 | **核验外部资料、结论真实性** |

### 5. 主动参与项目（核验规则）

插件不只是"偶尔求助的外援"，通过**主动核验规则**深度嵌入项目开发：
**引用外部资料前 → `verify` 核验真实性；写完关键代码 → `code-review`；方案定型前 → `adversary` 挑战。**

**安装即自动触发**：插件通过 `ctx.inject(['systemPrompt'])` 把精简核验规则自动注册进 agent 的 system prompt，无需手动配置 preset——主 agent 会在关键节点主动调用 `consult_llm` 独立核验。不想自动注入时，在插件 config 里设 `proactiveRules: false` 即可关闭。

完整规则与触发策略见 [`docs/PROACTIVE_PARTICIPATION.md`](docs/PROACTIVE_PARTICIPATION.md)。

### 6. ChatGPT 思考模式 / 模型

面板在 ChatGPT 站点显示 **🧠 思考** 开关（免费版已实测：点击"思考"pill 切换，状态实时同步）：
- **免费版**：思考模式开/关（`aria-pressed` 状态）
- **Plus**：模型选择器 + 思考强度（Low/Medium/High）——适配器已预留，面板检测到模型 pill 即显示当前模型

### 7. 命名会话

面板配置区 → "💬 会话"：每个站点可保存多个命名会话（自动记录标题与 URL），**新建 / 切换 / 删除**。一个项目一个会话，随时切回继续，`chat_log_<site>.jsonl` 全量可回溯。

### 8. Token 计量

状态栏显示 `⚡<累计tokens> tok / <次数> 次`（CJK 感知估算，输入+输出）。`GET ...token-usage` API 可查明细。

### 9. 自定义站点（面板配置）

配置区 → "🌐 自定义站点"：填 **站点名 + URL + 输入框选择器 + 回复选择器** 即可接入任意网页 LLM，无需写代码。保存后出现在站点下拉，切换即用。

### 10. 自定义角色

面板 ⚙️ → 输入角色名 + 提示词 → 保存。之后 `role` 填角色名即可。

**示例**：
```
保存 {name: "国学大师", prompt: "你是精通国学的大师，引经据典，文风典雅"}
发送 role: "国学大师" → 模型按国学大师风格回答
```

自定义角色适合：法律顾问、产品经理、架构师、面试官等任何你需要的"人设"。

### 11. agent 自动调用参数

| 参数 | 说明 |
|---|---|
| `question` | 问题（必填） |
| `provider` | `gemini`(默认) / `chatgpt` / `doubao` / `generic` |
| `role` | 内置或**自定义角色名**（留空=自由对话） |
| `context` | 待审内容（代码/文本/结论，可选） |
| `fresh` | `true`=新建对话开始新工作流；默认延续当前上下文 |

### 12. 工作流建议

- **审核流程**：主 agent 产出 → `role: review` 复核 → 汇总分歧点
- **双模型交叉**：Gemini 主用 + ChatGPT 备用（`provider` 切换），同一问题对比答案
- **项目对话归档**：一个项目一个会话，`chat_log_<site>.jsonl` 自动记录，可回溯
- **角色模板化**：把常用审查/写作角色存为自定义角色，团队共享

## API

| 路由 | 说明 |
|---|---|
| `GET /dsh-llm-bridge/api?action=sites` | 站点列表 + 当前站点 |
| `POST ...switch-site` | 切换站点 |
| `GET ...status` | 文字记录（最近 10 条）+ 摘要 + token 用量（`?n=` 调条数，`?since=` 增量） |
| `GET ...token-usage` | Token 用量明细（CJK 感知估算） |
| `GET ...progress` | 长任务进度（sending/generating/done） |
| `GET ...list-roles` | 内置 + 自定义角色列表 |
| `POST ...save-role` | 保存自定义角色 `{name, prompt}` |
| `POST ...delete-role` | 删除自定义角色 `{name}` |
| `GET ...auth-status` / `POST ...configure-cookie` / `POST ...clear-auth` | 认证管理 |
| `GET ...health-status` / `POST ...reconnect` | 会话健康检测 + 重连（非阻塞） |
| `GET ...daemon-status` / `POST ...daemon-start/stop` | 守护进程管理 |
| `POST ...send` | 发送消息 |
| `POST ...action` | 操作（new-chat / stop / screenshot / no-screenshot） |
| `POST ...rename-site` | 站点命名 |
| `GET/POST ...list-sessions` / `switch-session` / `rename-session` / `delete-session` | 命名会话管理 |
| `POST ...save-custom-site` / `delete-custom-site` | 自定义站点配置 |
| `POST ...click` / `eval` / `get-dom` | UI 驱动 + 调试（`{selector/testid/text/role}` 或 `{expression}`） |
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
dsh-llm-web-bridge/
├── package.json / cordis.patch.yml / LICENSE / README.md / CHANGELOG.md
├── .github/               # Issue/PR 模板 + CI
├── docs/
│   └── PROACTIVE_PARTICIPATION.md  # 主动核验规则（可挂载到 agent preset）
├── lib/
│   ├── index.js       # Host：API + consult_llm + 守护管理 + Xvfb
│   ├── client.js      # Client：面板（记录/实时/状态栏/配置/角色/会话/思考）
│   └── adapters/      # 站点适配器（gemini/chatgpt/doubao/generic）
└── daemon/
    ├── browser_daemon_webllm.py  # 浏览器守护（headless/headed）
    └── smoke_test.py             # CI 冒烟测试
```

## 常见问题

- **ChatGPT 卡"请稍候"**：Cloudflare challenge，等几秒或重试导航；确认 cookie 含 `cf_clearance`；有头模式（Xvfb）显著改善。
- **长回复被截断 / 60s 超时**：默认 180s / 8000 字符已放宽，仍不够用 `DSH_BRIDGE_REPLY_TIMEOUT` / `DSH_BRIDGE_MAX_REPLY_LEN` 调大。
- **改了代码不生效**：正式插件启动时加载，改后重启 DSH。
- **守护状态误判**：外部杀进程后先"⏹ 停止"再"▶ 启动"。
- **中文方块**：装中文字体 + `FONTCONFIG_FILE`。

## 安全说明

- Cookie 仅存本机 `<BASE>/`，不上传任何第三方；API 仅限 localhost。
- 自动化访问网页 LLM 请遵守各站服务条款；建议使用临时账号。
- 本项目仅供学习研究；使用者自行承担账号风险。

## License

MIT
