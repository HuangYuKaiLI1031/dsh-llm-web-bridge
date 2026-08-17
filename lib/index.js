// dsh-web-llm-bridge Host half.
// Multi-site bridge to third-party web LLMs. Design:
//   - ONE active site at a time (switch destroys the old context)
//   - conversation LOG (text) is the primary interface; live screenshot is
//     on-demand only
//   - per-site auth (cookies_<site>.json / storage_state_<site>.json)
//   - adapters isolate all site-specific selectors
//   - consult_llm tool for agent-driven consultation

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { getAdapter, listAdapters } from './adapters/index.js'

export const inject = ['webServer', 'tools', 'timer', 'subprocess']

// All runtime paths are configurable via plugin config or environment.
// Defaults keep the plugin usable out-of-the-box with the standard layout:
//   DSH_BRIDGE_BASE            runtime data dir (default: ./dsh-web-llm-bridge-data)
//   DSH_BRIDGE_PYTHON          python interpreter for the daemon
//   DSH_BRIDGE_BROWSERS        playwright browsers path
//   DSH_BRIDGE_FONTCONFIG      fontconfig file for CJK rendering
//   DSH_BRIDGE_XVFB            Xvfb binary (headed mode)
function resolveBase() {
  return process.env.DSH_BRIDGE_BASE || path.join(process.cwd(), 'dsh-web-llm-bridge-data')
}

const BASE = resolveBase()
const COMMAND_FILE = `${BASE}/commands_webllm.json`
const REPLY_FILE = `${BASE}/replies_webllm.json`
const DAEMON_PATH = process.env.DSH_BRIDGE_DAEMON || `${BASE}/browser_daemon_webllm.py`
const PYTHON_BIN = process.env.DSH_BRIDGE_PYTHON || `${BASE}/.venv/bin/python`
const PLAYWRIGHT_BROWSERS = process.env.DSH_BRIDGE_BROWSERS || `${BASE}/.pw-browsers`
const FONTCONFIG_FILE = process.env.DSH_BRIDGE_FONTCONFIG || `${BASE}/fonts.conf`
const XVFB_BIN = process.env.DSH_BRIDGE_XVFB || 'Xvfb'

const ROLES = {
  review: '你是一位严格、独立的审核员。请客观审查以下内容：指出事实错误、逻辑漏洞、遗漏之处，并给出具体的改进建议。请直接给出审查意见。',
  'code-review': '你是一位资深的代码审查专家。请审查以下代码：检查正确性、边界情况、安全性、可读性和性能；指出 bug 并给出修复建议。请直接给出审查意见。',
  translator: '你是一位专业翻译。请将以下内容翻译成自然、准确的中文（除非另有说明），保留原文语气与专业术语。',
  adversary: '你是一位红队对抗专家。请从批判视角审视以下结论或方案：找出所有可能的反驳点、反例、风险与未考虑的场景，越尖锐越好。',
  reasoner: '你是一位严谨的推理专家。请逐步推导以下问题，显式检查每一步的逻辑，并给出可靠结论。',
  editor: '你是一位资深编辑。请润色以下文本：改进表达、结构与用词，保持原意，并简要说明主要改动。',
}

// Completion marker: the LLM is asked to emit this exact sentence as the LAST
// line after finishing its reply. Natural-language markers survive model
// rewriting far better than symbol tokens (underscores/angles get mangled).
const COMPLETION_MARKER = '回答完成，请检查。'

function buildQuestion(role, context, question) {
  let text = ''
  if (role) {
    // role may be a built-in or a user-defined custom role
    const persona = customRoles.get(role) || ROLES[role]
    if (persona) text += `${persona}\n\n`
  }
  if (context && context.trim()) text += `【需要处理的背景内容】\n${context.trim()}\n\n`
  text += `【任务】\n${question.trim()}\n\n`
  text += `【回复格式要求】回答的最后一行，必须一字不差地输出下面这个完整句子作为结束标记（不要修改、不要省略、不要加标点改动）：\n${COMPLETION_MARKER}`
  return text
}

// ── custom roles (in-memory map persisted to custom_roles.json) ────────────
const CUSTOM_ROLES_FILE = `${BASE}/custom_roles.json`
const customRoles = new Map()

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > 512 * 1024) throw new Error('request body too large')
    chunks.push(value)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function assertLocalRequest(req) {
  const host = String(req.headers.host ?? '').split(':')[0].replace(/^\[|\]$/g, '')
  if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error('only local requests allowed')
  }
}

/** Smart cookie parser — auto-detects 5 formats (same as dsh-gemini-bridge). */
function parseCookies(payload) {
  const text = String(payload).trim()
  if (!text) throw new Error('empty payload')
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed.map(normalizeCookie).filter(Boolean)
      if (parsed && typeof parsed === 'object') {
        const vals = Object.values(parsed)
        if (vals.some(v => v && typeof v === 'object' && ('name' in v || 'value' in v))) return vals.map(normalizeCookie).filter(Boolean)
        return Object.entries(parsed).map(([name, value]) => normalizeCookie({ name, value })).filter(Boolean)
      }
    } catch (e) { /* fall through */ }
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const netscapeRows = lines.filter(l => l.split('\t').length >= 7 && l.split('\t')[2] === '/')
  if (netscapeRows.length === lines.length && netscapeRows.length > 0) {
    return netscapeRows.map((line) => {
      const parts = line.split('\t')
      return normalizeCookie({
        name: parts[5], value: parts[6] ?? '', domain: parts[0], path: parts[2],
        secure: parts[3] === 'TRUE', httpOnly: parts[1] === 'TRUE',
        expires: parts[4] && parts[4] !== '0' ? Number(parts[4]) : undefined,
      })
    }).filter(Boolean)
  }
  const tableRows = []
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split('\t')
    if (parts.length < 4) continue
    if (i === 0 && /name/i.test(parts[0]) && /value/i.test(parts[1])) continue
    tableRows.push({ parts })
  }
  if (tableRows.length > 0) {
    // Table detection: at least 2/3 of rows look like tab-separated cookie
    // rows (col0 = cookie name, col1 = value, col2 = domain-ish, col3 = path).
    const tableLike = tableRows.filter(r => {
      const p = r.parts
      return p.length >= 4
        && !p[0].includes('=')             // name column is not name=value
        && p[2].includes('.')              // domain column contains a dot
        && (p[3] === '/' || p[3].startsWith('/'))
    })
    if (tableLike.length >= Math.ceil(tableRows.length * 2 / 3)) {
      return tableLike.map(({ parts }) => normalizeCookie({
        name: parts[0].trim(), value: parts[1] ?? '', domain: parts[2].trim(), path: parts[3] ?? '/',
        httpOnly: (parts[6] ?? '').includes('✓') || (parts[6] ?? '').toLowerCase() === 'true',
        secure: (parts[7] ?? '').includes('✓') || (parts[7] ?? '').toLowerCase() === 'true',
      })).filter(Boolean)
    }
  }
  const pairs = []
  for (const line of lines) {
    for (const seg of line.split(';')) {
      const pair = seg.trim()
      if (!pair) continue
      const eq = pair.indexOf('=')
      const name = eq === -1 ? pair : pair.slice(0, eq).trim()
      const value = eq === -1 ? '' : pair.slice(eq + 1).trim()
      if (name) pairs.push({ name, value })
    }
  }
  if (pairs.length === 0) throw new Error('no cookie-like content detected')
  return pairs.map(p => normalizeCookie(p)).filter(Boolean)
}

function normalizeCookie(c) {
  if (!c || typeof c !== 'object') return null
  const name = String(c.name ?? c.key ?? '').trim()
  if (!name) return null
  const value = c.value === undefined || c.value === null ? '' : String(c.value)
  const out = { name, value, domain: c.domain ? String(c.domain) : '.google.com', path: c.path ? String(c.path) : '/' }
  if (c.secure === true || c.secure === 'TRUE' || c.secure === 'true') out.secure = true
  if (c.httpOnly === true || c.httpOnly === 'TRUE' || c.httpOnly === 'true') out.httpOnly = true
  if (c.expires !== undefined && c.expires !== null && Number(c.expires) > 0) out.expires = Number(c.expires)
  return out
}

export function apply(ctx, config = {}) {
  const apiRoute = config.apiPath ?? '/dsh-llm-bridge/api'
  const frameRoute = config.framePath ?? '/dsh-llm-bridge/frame.jpg'
  const daemonPath = config.daemonPath ?? DAEMON_PATH
  const pythonBin = config.pythonBin ?? PYTHON_BIN
  const playwrightBrowsers = config.playwrightBrowsers ?? PLAYWRIGHT_BROWSERS
  const fontconfigFile = config.fontconfigFile ?? FONTCONFIG_FILE
  // load persisted custom roles into the in-memory map
  ;(async () => {
    try {
      const raw = await fs.readFile(CUSTOM_ROLES_FILE, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        customRoles.clear()
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v.trim()) customRoles.set(k, v)
        }
      }
    } catch (e) { /* no custom roles yet */ }
  })()
  let daemonHandle = null
  let xvfbHandle = null
  let activeSite = 'gemini'

  // ---- Xvfb lifecycle (virtual display for headed mode) ----
  const xvfbBin = config.xvfbBin ?? XVFB_BIN
  const display = config.display ?? ':99'

  const ensureXvfb = async () => {
    if (xvfbHandle !== null) return { ok: true, already: true }
    try {
      const exe = await ctx.subprocess.resolveExecutable(xvfbBin)
      xvfbHandle = ctx.subprocess.spawn({
        argv: [exe, display, '-screen', '0', '1280x860x24', '-nolisten', 'tcp'],
        cwd: BASE,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 128 * 1024, spill: `${BASE}/xvfb.stdout.log` },
          stderr: { maxBytes: 128 * 1024, spill: `${BASE}/xvfb.stderr.log` },
        },
        graceMs: 3000,
      })
      // give the display socket time to appear
      await ctx.timer.timeout(1500)
      return { ok: true, already: false }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  const stopXvfb = async () => {
    if (xvfbHandle === null) return
    try { xvfbHandle.terminate() } catch (e) { /* already gone */ }
    xvfbHandle = null
  }

  // ---- daemon lifecycle ----
  const daemonRunning = () => daemonHandle !== null

  const startDaemon = async () => {
    if (daemonHandle !== null) return { ok: true, already: true }
    try {
      const headlessMode = config.headless !== undefined ? config.headless : false // default HEADED
      const env = {
        PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsers,
        FONTCONFIG_FILE: fontconfigFile,
        DSH_HEADLESS: headlessMode ? '1' : '0',
      }
      if (!headlessMode) {
        // headed mode: ensure the virtual display is up, then point DISPLAY at it
        const xvfbResult = await ensureXvfb()
        if (!xvfbResult.ok) return { ok: false, error: `xvfb start failed: ${xvfbResult.error}` }
        env.DISPLAY = display
      }
      const exe = await ctx.subprocess.resolveExecutable(pythonBin)
      daemonHandle = ctx.subprocess.spawn({
        argv: [exe, daemonPath],
        cwd: BASE,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 512 * 1024, spill: `${BASE}/webllm.daemon.stdout.log` },
          stderr: { maxBytes: 512 * 1024, spill: `${BASE}/webllm.daemon.stderr.log` },
        },
        graceMs: 5000,
        env,
      })
      return { ok: true, already: false }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  const stopDaemon = async () => {
    if (daemonHandle === null) return { ok: true, already: false }
    try { daemonHandle.terminate() } catch (e) { /* already gone */ }
    daemonHandle = null
    await stopXvfb()
    return { ok: true }
  }

  ctx.effect(() => {
    void startDaemon()
    return () => { void stopDaemon() }
  })

  // ---- send a command to the daemon and wait for the reply ----
  const consult = async (cmd, timeoutMs = 90000) => {
    try {
      await fs.writeFile(COMMAND_FILE, JSON.stringify(cmd), 'utf8')
    } catch (e) {
      return { ok: false, reply: '', error: `cannot write command: ${e.message}` }
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await ctx.timer.timeout(800)
      try {
        const data = await fs.readFile(REPLY_FILE, 'utf8')
        if (data && data.trim()) {
          const parsed = JSON.parse(data)
          if (parsed && parsed.id === cmd.id) {
            return { ok: parsed.ok === true, reply: parsed.reply || '', error: parsed.error || '' }
          }
        }
      } catch (e) { /* reply not ready yet */ }
    }
    return { ok: false, reply: '', error: 'timeout: browser did not answer' }
  }

  const siteLogFile = (site) => `${BASE}/chat_log_${site}.jsonl`
  const siteFrameFile = (site) => `${BASE}/live_frame_${site}.jpg`

  // ---- API route ----
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: apiRoute,
    handler: async (req, res) => {
      try {
        assertLocalRequest(req)
        const url = new URL(req.url ?? apiRoute, 'http://localhost')
        const body = req.method === 'POST' ? await readBody(req) : {}
        const action = typeof body.action === 'string' ? body.action : (url.searchParams.get('action') ?? 'status')
        const site = typeof body.site === 'string' && body.site ? body.site : activeSite

        if (action === 'sites') {
          let meta = {}
          try {
            const raw = await fs.readFile(`${BASE}/site_meta.json`, 'utf8')
            if (raw && raw.trim()) meta = JSON.parse(raw)
          } catch (e) { /* no meta yet */ }
          const sites = listAdapters().map(s => ({
            ...s,
            label: (meta[s.name] && meta[s.name].label) || s.label,
          }))
          return writeJson(res, 200, { ok: true, sites, active: activeSite })
        }

        if (action === 'rename-site') {
          const adapter = getAdapter(site)
          if (!adapter) return writeJson(res, 400, { ok: false, error: `unknown site ${site}` })
          const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null
          let meta = {}
          try {
            const raw = await fs.readFile(`${BASE}/site_meta.json`, 'utf8')
            if (raw && raw.trim()) meta = JSON.parse(raw)
          } catch (e) { /* no meta yet */ }
          if (!meta[site]) meta[site] = {}
          if (label) meta[site].label = label
          else delete meta[site].label
          await fs.writeFile(`${BASE}/site_meta.json`, JSON.stringify(meta, null, 2), 'utf8')
          return writeJson(res, 200, { ok: true, site, label: label || adapter.label })
        }

        if (action === 'list-roles') {
          const custom = {}
          for (const [k, v] of customRoles.entries()) custom[k] = v
          return writeJson(res, 200, { ok: true, builtin: Object.keys(ROLES), custom })
        }

        if (action === 'save-role') {
          const name = typeof body.name === 'string' ? body.name.trim() : ''
          const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
          if (!name || !prompt) return writeJson(res, 400, { ok: false, error: 'name and prompt are required' })
          if (ROLES[name]) return writeJson(res, 400, { ok: false, error: `"${name}" 是内置角色名，请换一个名字` })
          customRoles.set(name, prompt)
          const obj = {}
          for (const [k, v] of customRoles.entries()) obj[k] = v
          await fs.writeFile(CUSTOM_ROLES_FILE, JSON.stringify(obj, null, 2), 'utf8')
          return writeJson(res, 200, { ok: true, name, hint: `已保存自定义角色 "${name}"` })
        }

        if (action === 'delete-role') {
          const name = typeof body.name === 'string' ? body.name.trim() : ''
          if (!name) return writeJson(res, 400, { ok: false, error: 'name is required' })
          customRoles.delete(name)
          const obj = {}
          for (const [k, v] of customRoles.entries()) obj[k] = v
          await fs.writeFile(CUSTOM_ROLES_FILE, JSON.stringify(obj, null, 2), 'utf8')
          return writeJson(res, 200, { ok: true, hint: `已删除自定义角色 "${name}"` })
        }

        if (action === 'switch-site') {
          const adapter = getAdapter(site)
          if (!adapter) return writeJson(res, 400, { ok: false, error: `unknown site ${site}` })
          const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
          const result = await consult({ id, site }, 90000)
          if (result.ok) activeSite = site
          return writeJson(res, result.ok ? 200 : 500, result)
        }

        if (action === 'status') {
          const log = siteLogFile(site)
          let entries = []
          try {
            const raw = await fs.readFile(log, 'utf8')
            entries = raw.trim().split('\n').filter(Boolean).slice(-50).map(l => {
              try { return JSON.parse(l) } catch (e) { return null }
            }).filter(Boolean)
          } catch (e) { /* no log yet */ }
          let frameExists = false
          try { frameExists = (await fs.stat(siteFrameFile(site))).size > 0 } catch (e) { /* no frame */ }
          return writeJson(res, 200, { ok: true, site, active: activeSite, log: entries, hasFrame: frameExists })
        }

        if (action === 'auth-status') {
          const authFile = `${BASE}/auth_status_${site}.json`
          let auth = { source: 'none', logged_in: false }
          try {
            const raw = await fs.readFile(authFile, 'utf8')
            if (raw && raw.trim()) auth = { ...auth, ...JSON.parse(raw) }
          } catch (e) { /* not written yet */ }
          const cookieFile = `${BASE}/cookies_${site}.json`
          const storageFile = `${BASE}/storage_state_${site}.json`
          const hasCookies = await fs.stat(cookieFile).then(() => true).catch(() => false)
          const hasStorage = await fs.stat(storageFile).then(() => true).catch(() => false)
          return writeJson(res, 200, {
            ok: true,
            site,
            loggedIn: !!auth.logged_in,
            source: auth.source || 'none',
            hasCookies,
            hasStorage,
            daemonRunning: daemonRunning(),
            guide: `在配置区粘贴 ${site} 的会话 Cookie（JSON 数组或 Cookie 字符串）即可自动登录。`,
          })
        }

        if (action === 'configure-cookie') {
          const payload = typeof body.cookies === 'string' ? body.cookies : ''
          if (!payload.trim()) return writeJson(res, 400, { ok: false, error: 'cookies payload is required' })
          try {
            const parsed = parseCookies(payload)
            const adapter = getAdapter(site)
            await fs.writeFile(`${BASE}/cookies_${site}.json`, JSON.stringify(parsed, null, 2), 'utf8')
            try { await fs.unlink(`${BASE}/storage_state_${site}.json`) } catch (e) { /* may not exist */ }
            // Auto-reload: rebuild this site's context so the running daemon
            // picks up the new cookies immediately — no manual restart needed.
            let reload = { ok: true, note: '未自动重载' }
            if (adapter && daemonRunning()) {
              const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
              const res2 = await consult({ id, site, reconnect: true }, 90000)
              reload = { ok: res2.ok, note: res2.ok ? '已自动重载' : `重载失败: ${res2.error || ''}` }
              if (res2.ok) activeSite = site
            }
            return writeJson(res, 200, {
              ok: true,
              site,
              count: parsed.length,
              reloaded: reload.ok,
              hint: `已保存 ${site} Cookie（${parsed.length} 条），${reload.note}。`,
            })
          } catch (e) {
            return writeJson(res, 400, { ok: false, error: `invalid cookies: ${e.message}` })
          }
        }

        if (action === 'clear-auth') {
          try { await fs.unlink(`${BASE}/cookies_${site}.json`) } catch (e) { /* may not exist */ }
          try { await fs.unlink(`${BASE}/storage_state_${site}.json`) } catch (e) { /* may not exist */ }
          return writeJson(res, 200, { ok: true, hint: `${site} 认证信息已清除。` })
        }

        if (action === 'daemon-status') return writeJson(res, 200, { ok: true, running: daemonRunning() })
        if (action === 'health-status') {
          // Ask the daemon to run an immediate health probe (instead of
          // returning a possibly-stale periodic report), then read the result.
          if (daemonRunning()) {
            try {
              const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
              await consult({ id, site, healthCheck: true }, 8000)
            } catch (e) { /* daemon may be mid-command */ }
          }
          let health = { healthy: null, site: activeSite }
          try {
            const raw = await fs.readFile(`${BASE}/health_status.json`, 'utf8')
            if (raw && raw.trim()) health = JSON.parse(raw)
          } catch (e) { /* no health report yet */ }
          return writeJson(res, 200, { ok: true, ...health })
        }
        if (action === 'reconnect') {
          // force a site re-switch to rebuild the context (fresh login),
          // including same-site reconnect (picks up fresh cookies)
          const adapter = getAdapter(site)
          if (!adapter) return writeJson(res, 400, { ok: false, error: `unknown site ${site}` })
          const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
          const result = await consult({ id, site, reconnect: true }, 90000)
          if (result.ok) activeSite = site
          return writeJson(res, result.ok ? 200 : 500, result)
        }
        if (action === 'daemon-start') {
          const result = await startDaemon()
          return writeJson(res, result.ok ? 200 : 500, result)
        }
        if (action === 'daemon-stop') {
          const result = await stopDaemon()
          return writeJson(res, result.ok ? 200 : 500, result)
        }

        if (action === 'send' || action === 'action') {
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          const act = typeof body.actionValue === 'string' ? body.actionValue.trim() : ''
          const role = typeof body.role === 'string' ? body.role : ''
          const context = typeof body.context === 'string' ? body.context : ''
          const fresh = !!body.fresh
          if (!text && !act) return writeJson(res, 400, { ok: false, error: 'empty command' })
          const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
          let cmd
          if (text) cmd = { id, site, text: buildQuestion(role, context, text), ...(fresh ? { fresh: true } : {}) }
          else cmd = { id, site, action: act }
          const result = await consult(cmd)
          return writeJson(res, result.ok ? 200 : 504, result)
        }

        return writeJson(res, 400, { ok: false, error: `unknown action ${action}` })
      } catch (e) {
        return writeJson(res, 500, { ok: false, error: e.message })
      }
    },
  }))

  // ---- frame route (on-demand screenshot) ----
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: frameRoute,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? frameRoute, 'http://localhost')
        const reqSite = url.searchParams.get('site')
        const site = (reqSite && getAdapter(reqSite)) ? reqSite : activeSite
        const bytes = await fs.readFile(siteFrameFile(site))
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'cache-control': 'no-store, max-age=0',
          'pragma': 'no-cache',
        })
        res.end(bytes)
      } catch (e) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('frame not ready — enable live view first')
      }
    },
  }))

  // ---- global tool: consult_llm ----
  ctx.effect(() => {
    const definition = {
      name: 'consult_llm',
      description: 'Consult a third-party web LLM (Gemini, ChatGPT, or a generic custom site) in its real browser. Use this when you need independent review, a second opinion, cross-checking of your reasoning, translation, code review, or an adversarial challenge to your conclusion. The conversation log (text) is the primary record; the live browser panel is available on demand.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: { type: 'string', description: 'The question or task for the LLM. Be specific about what you want reviewed/checked/translated.' },
          provider: {
            type: 'string',
            description: 'Which web LLM site to use. gemini (default), chatgpt, or generic (custom-configured site).',
            default: 'gemini',
          },
          role: {
            type: 'string',
            description: 'Consultation role. review=independent auditor (default); code-review=code audit; translator=translation; adversary=red-team challenge; reasoner=step-by-step reasoning; editor=polish/rewrite.',
            default: 'review',
          },
          context: { type: 'string', description: 'Background material for the LLM to review: the code, text, conclusion, or document under question. Omit if the question is self-contained.' },
          fresh: { type: 'boolean', description: 'Start a NEW conversation before asking (begin a new workflow). Default false = keep the current conversation context for follow-up questions.', default: false },
        },
        required: ['question'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            reply: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok', 'reply', 'error'],
        },
        render: (args, value) => [{
          type: 'text',
          text: value && value.ok
            ? `[${String(args.provider || 'gemini')}] (${String(args.role || 'review')}) 回复：\n\n${String(value.reply || '')}`
            : `LLM 调用失败：${String((value && value.error) || 'unknown')}`,
        }],
        presentationMeta: (args, value) => ({
          provider: String(args.provider || 'gemini'),
          role: String(args.role || 'review'),
          ok: !!(value && value.ok),
          replyLen: value && value.reply ? String(value.reply).length : 0,
        }),
      },
      async execute(args) {
        const question = args && typeof args.question === 'string' ? args.question.trim() : ''
        if (!question) return { ok: false, reply: '', error: 'question is required' }
        const provider = args && typeof args.provider === 'string' && args.provider ? args.provider : 'gemini'
        if (!getAdapter(provider)) return { ok: false, reply: '', error: `unknown provider ${provider}` }
        const role = args && typeof args.role === 'string' ? args.role.trim() : 'review'
        const context = args && typeof args.context === 'string' ? args.context : ''
        const fresh = !!(args && args.fresh)
        const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
        const cmd = { id, site: provider, text: buildQuestion(role, context, question), ...(fresh ? { fresh: true } : {}) }
        // switching sites costs time; consult may need the switch
        const result = await consult(cmd)
        if (result.ok) activeSite = provider
        return result
      },
    }
    return ctx.tools.register(definition)
  })
}
