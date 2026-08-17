// dsh-web-llm-bridge Client half.
// Primary interface: text conversation log. Live screenshot view is an
// on-demand mode (toggle). Site switch via provider selector.

window.__ModuleLoader__.load({
  id: "dsh-web-llm-bridge",
  factory: (require) => {
    const React = require("react")
    const e = React.createElement
    const { useEffect, useRef, useState } = React

    const FRAME = "/dsh-llm-bridge/frame.jpg"
    const API = "/dsh-llm-bridge/api"

    async function api(action, body) {
      const response = await fetch(`${API}?action=${encodeURIComponent(action)}`, {
        method: body ? "POST" : "GET",
        cache: "no-store",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify({ action, ...body }) : undefined,
      })
      const result = await response.json()
      if (!result.ok) throw new Error(result.error || `request failed (${response.status})`)
      return result
    }

    const css = ".dsh-wl-root{position:fixed;z-index:2147482000;width:400px;background:#111318;border:2px solid #2f7cf6;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.6);overflow:hidden;font-family:system-ui,sans-serif;color:#e8eaed}.dsh-wl-head{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#1a1d23;color:#e8eaed;font-size:12px;font-weight:600;cursor:move;user-select:none}.dsh-wl-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.dsh-wl-actions{display:flex;flex-wrap:wrap;gap:6px;padding:6px 8px;border-top:1px solid #33383f;background:#14171c}.dsh-wl-btn{padding:4px 10px;border-radius:6px;border:1px solid #3a3f47;background:#1f232b;color:#c8d0da;cursor:pointer;font-size:12px}.dsh-wl-btn:disabled{cursor:wait;opacity:.6}.dsh-wl-select{padding:4px 8px;border-radius:6px;border:1px solid #3a3f47;background:#1f232b;color:#c8d0da;font-size:12px}.dsh-wl-log{max-height:240px;overflow-y:auto;padding:8px 10px;background:#0f1115;font-size:12px;line-height:1.5}.dsh-wl-q{color:#8ab4f8;margin-bottom:2px;white-space:pre-wrap;word-break:break-word}.dsh-wl-a{color:#c8d0da;margin-bottom:10px;white-space:pre-wrap;word-break:break-word}.dsh-wl-a.err{color:#ff8a80}.dsh-wl-img{display:block;width:100%;max-height:280px;object-fit:contain;background:#000}.dsh-wl-inputrow{display:flex;gap:6px;padding:8px;border-top:1px solid #33383f;background:#171a20}.dsh-wl-input{flex:1;padding:6px 8px;border-radius:6px;border:1px solid #3a3f47;background:#0f1115;color:#e8eaed;font-size:13px}.dsh-wl-send{padding:6px 12px;border-radius:6px;border:none;background:#2f7cf6;color:#fff;cursor:pointer;font-size:13px}.dsh-wl-cfg{padding:8px;border-top:1px solid #33383f;background:#14171c}.dsh-wl-ta{width:100%;min-height:70px;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid #3a3f47;background:#0f1115;color:#e8eaed;font-size:12px;resize:vertical;font-family:monospace}.dsh-wl-status{font-size:11px;color:#9aa0a6;line-height:1.5;margin-bottom:6px}"

    function installStyle() {
      if (document.getElementById("dsh-wl-style")) return
      const node = document.createElement("style")
      node.id = "dsh-wl-style"
      node.textContent = css
      document.head.appendChild(node)
    }

    function WebLlmView(props = {}) {
      const [sites, setSites] = useState([])
      const [site, setSite] = useState("gemini")
      const [mode, setMode] = useState("text") // 'text' | 'live'
      const [log, setLog] = useState([])
      const [status, setStatus] = useState("connecting")
      const [open, setOpen] = useState(true)
      const [input, setInput] = useState("")
      const [busy, setBusy] = useState(false)
      const [authOpen, setAuthOpen] = useState(false)
      const [cookieText, setCookieText] = useState("")
      const [authInfo, setAuthInfo] = useState("")
      const [ts, setTs] = useState(Date.now())
      const [pos, setPos] = useState(null)
      const [health, setHealth] = useState(null)
      const drag = useRef(null)

      const refreshHealth = () => {
        api("health-status", { site }).then(r => {
          if (r && typeof r.healthy === 'boolean') setHealth(r)
        }).catch(() => {})
      }

      const refresh = () => {
        api("sites").then(r => { setSites(r.sites || []); if (r.active) setSite(r.active) }).catch(() => {})
        api("status", { site }).then(r => {
          setStatus(r.daemonRunning === false ? "daemon-off" : (r.log ? "live" : "idle"))
          setLog(r.log || [])
        }).catch(() => setStatus("offline"))
        refreshHealth()
      }

      useEffect(() => {
        installStyle()
        refresh()
        const timer = setInterval(() => {
          setTs(Date.now())
          api("status", { site }).then(r => setLog(r.log || [])).catch(() => {})
          refreshHealth()
        }, 3000)
        return () => clearInterval(timer)
      }, [site])

      const reconnect = () => {
        setBusy(true)
        api("reconnect", { site }).then(() => { setAuthInfo("已重新连接"); refresh() })
          .catch(caught => setAuthInfo(caught instanceof Error ? caught.message : String(caught)))
          .finally(() => setBusy(false))
      }

      const send = () => {
        const text = input.trim()
        if (!text || busy) return
        setBusy(true)
        api("send", { site, text }).then(() => refresh())
          .catch(caught => setAuthInfo(caught instanceof Error ? caught.message : String(caught)))
          .finally(() => { setBusy(false); setInput("") })
      }

      const runAction = (value) => {
        if (busy) return
        setBusy(true)
        api("action", { site, actionValue: value }).then(() => refresh())
          .catch(caught => setAuthInfo(caught instanceof Error ? caught.message : String(caught)))
          .finally(() => setBusy(false))
      }

      const toggleMode = (next) => {
        setMode(next)
        // live view = ask the daemon to start screenshotting (on-demand)
        api("action", { site, actionValue: next === "live" ? "screenshot" : "no-screenshot" })
          .then(() => { if (next === "live") setTs(Date.now()) })
          .catch(() => {})
      }

      const switchSite = (value) => {
        if (value === site) return
        setBusy(true)
        api("switch-site", { site: value }).then(() => { setSite(value); setMode("text"); refresh() })
          .catch(caught => setAuthInfo(caught instanceof Error ? caught.message : String(caught)))
          .finally(() => setBusy(false))
      }

      const refreshAuth = () => {
        api("auth-status", { site }).then(r => {
          const src = r.source === "storage_state" ? "登录引导" : r.source === "cookies" ? `Cookie(${r.count || "?"})` : "未配置"
          setAuthInfo(`${site} · 登录:${r.loggedIn ? "✅" : "❌"} · ${src}`)
        }).catch(caught => setAuthInfo(caught instanceof Error ? caught.message : String(caught)))
        loadRoles()
      }

      const saveCookie = () => {
        if (!cookieText.trim()) return
        setBusy(true)
        api("configure-cookie", { site, cookies: cookieText.trim() })
          .then(r => setAuthInfo(`✅ 已保存 ${r.count || "?"} 条，重启守护后生效`))
          .catch(caught => setAuthInfo(caught instanceof Error ? caught.message : String(caught)))
          .finally(() => setBusy(false))
      }

      const clearAuth = () => {
        api("clear-auth", { site }).then(r => setAuthInfo(String(r.hint || "已清除"))).catch(() => {})
      }

      const [renameText, setRenameText] = useState("")
      const renameSite = () => {
        if (!renameText.trim()) return
        setBusy(true)
        api("rename-site", { site, label: renameText.trim() })
          .then(() => { setAuthInfo(`✅ 已重命名为 ${renameText.trim()}`); setRenameText(""); refresh() })
          .catch(caught => setAuthInfo(caught instanceof Error ? caught.message : String(caught)))
          .finally(() => setBusy(false))
      }

      // custom roles
      const [roleName, setRoleName] = useState("")
      const [rolePrompt, setRolePrompt] = useState("")
      const [customRoles, setCustomRoles] = useState([])
      const [builtinRoles, setBuiltinRoles] = useState([])
      const loadRoles = () => {
        api("list-roles").then(r => {
          setBuiltinRoles(r.builtin || [])
          setCustomRoles(Object.keys(r.custom || {}))
        }).catch(() => {})
      }
      const saveRole = () => {
        if (!roleName.trim() || !rolePrompt.trim()) return
        setBusy(true)
        api("save-role", { name: roleName.trim(), prompt: rolePrompt.trim() })
          .then(r => { setAuthInfo(String(r.hint || "已保存")); setRoleName(""); setRolePrompt(""); loadRoles() })
          .catch(caught => setAuthInfo(caught instanceof Error ? caught.message : String(caught)))
          .finally(() => setBusy(false))
      }
      const deleteRole = (name) => {
        setBusy(true)
        api("delete-role", { name }).then(() => { loadRoles(); setAuthInfo(`已删除 "${name}"`) })
          .catch(caught => setAuthInfo(caught instanceof Error ? caught.message : String(caught)))
          .finally(() => setBusy(false))
      }

      const onDown = (ev) => {
        if (ev.button !== 0) return
        const baseX = pos ? pos.x : (window.innerWidth - 420)
        const baseY = pos ? pos.y : 100
        drag.current = { dx: ev.clientX - baseX, dy: ev.clientY - baseY }
      }
      const onMove = (ev) => {
        if (!drag.current) return
        setPos({
          x: Math.max(0, Math.min(ev.clientX - drag.current.dx, window.innerWidth - 120)),
          y: Math.max(0, Math.min(ev.clientY - drag.current.dy, window.innerHeight - 60)),
        })
      }
      const onUp = () => { drag.current = null }

      const dot = { background: status === "live" ? "#4caf50" : (status === "daemon-off" ? "#f44336" : (status === "connecting" ? "#ffb300" : "#9aa0a6")) }
      const btn = (label, onClick, extra) => e("button", { className: "dsh-wl-btn", onClick, disabled: busy, style: extra }, label)

      // connection + session status bar
      const connLabel = status === "daemon-off" ? "守护未运行"
        : health === null ? "连接中…"
        : health.healthy ? "已连接" : "会话异常"
      const connColor = status === "daemon-off" ? "#f44336"
        : health === null ? "#ffb300"
        : health.healthy ? "#4caf50" : "#f44336"
      const statusBar = e("div", {
        style: {
          display: "flex", alignItems: "center", gap: "10px",
          padding: "4px 10px", background: "#0f1115",
          borderBottom: "1px solid #2a2f3a", fontSize: "11px", color: "#9aa0a6",
        },
      },
        e("span", null,
          e("span", { style: { display: "inline-block", width: 8, height: 8, borderRadius: "50%", marginRight: 4, background: connColor } }),
          connLabel,
        ),
        e("span", null, "站点: " + site),
        e("span", null, "模式: " + (mode === "live" ? "实时" : "记录")),
      )

      const siteSel = e("select", {
        className: "dsh-wl-select",
        value: site,
        onChange: ev => switchSite(ev.target.value),
      }, (sites.length ? sites : [{ name: "gemini", label: "Gemini" }]).map(s => e("option", { key: s.name, value: s.name }, s.label)))

      const actionRow = e("div", { className: "dsh-wl-actions" },
        siteSel,
        btn("🆕 新建", () => runAction("new-chat")),
        btn("⏹ 停止", () => runAction("stop"), { background: "#3a2222", borderColor: "#6b3a3a", color: "#ffb4a8" }),
        btn(mode === "text" ? "📷 实时" : "📝 记录", () => toggleMode(mode === "text" ? "live" : "text")),
        btn(authOpen ? "⚙️ 关闭" : "⚙️ 配置", () => { setAuthOpen(!authOpen); if (!authOpen) refreshAuth() }, { background: "#2a2f3a", borderColor: "#4a5568" }),
      )

      const logBox = e("div", { className: "dsh-wl-log" },
        log.length === 0 ? e("div", { style: { color: "#6b7280" } }, "暂无对话记录") : null,
        log.map((entry, i) => {
          const key = entry.id || i
          if (entry.kind === "action") {
            return e("div", { key, className: "dsh-wl-a" }, `【操作】${entry.reply || entry.action || ""}`)
          }
          return e("div", { key },
            e("div", { className: "dsh-wl-q" }, entry.question || ""),
            e("div", { className: `dsh-wl-a${entry.ok ? "" : " err"}` }, entry.error || entry.reply || ""),
          )
        }),
      )

      const liveBox = e("div", null,
        e("img", { className: "dsh-wl-img", src: `${FRAME}?t=${ts}&site=${site}`, alt: "live view" }),
      )

      const authPanel = authOpen ? e("div", { className: "dsh-wl-cfg" },
        e("div", { className: "dsh-wl-status" }, authInfo || "读取认证状态…"),
        e("textarea", {
          className: "dsh-wl-ta",
          value: cookieText,
          onChange: ev => setCookieText(ev.target.value),
          placeholder: `粘贴 ${site} 的 Cookie（JSON 数组、表格或 a=b; c=d 字符串）`,
        }),
        e("div", { style: { display: "flex", gap: "6px", marginTop: "6px" } },
          btn("保存 Cookie", saveCookie, {}),
          btn("清除认证", clearAuth, {}),
          btn("刷新状态", refreshAuth, {}),
        ),
        e("div", { style: { display: "flex", gap: "6px", marginTop: "8px", borderTop: "1px solid #33383f", paddingTop: "8px" } },
          e("input", {
            className: "dsh-wl-input",
            value: renameText,
            onChange: ev => setRenameText(ev.target.value),
            placeholder: `给 ${site} 起个名字…`,
          }),
          btn("重命名", renameSite, {}),
        ),
        e("div", { style: { marginTop: "8px", borderTop: "1px solid #33383f", paddingTop: "8px" } },
          e("div", { className: "dsh-wl-status" }, "🎭 自定义角色（发送时 role 填角色名）"),
          e("div", { style: { display: "flex", gap: "6px" } },
            e("input", {
              className: "dsh-wl-input",
              value: roleName,
              onChange: ev => setRoleName(ev.target.value),
              placeholder: "角色名（如 国学大师）",
            }),
            e("input", {
              className: "dsh-wl-input",
              value: rolePrompt,
              onChange: ev => setRolePrompt(ev.target.value),
              placeholder: "角色提示词（如：你是精通国学的大师…）",
            }),
            btn("保存角色", saveRole, {}),
          ),
          e("div", { className: "dsh-wl-status", style: { marginTop: "6px" } },
            "内置: " + (builtinRoles.length ? builtinRoles.join(", ") : "…"),
          ),
          customRoles.length ? e("div", { className: "dsh-wl-status", style: { marginTop: "4px" } },
            "自定义: ",
            customRoles.map(n => e("span", { key: n, style: { marginRight: 8 } },
              n, " ", e("button", { className: "dsh-wl-btn", onClick: () => deleteRole(n), style: { padding: "0 6px", fontSize: 11 } }, "✕"),
            )),
          ) : null,
        ),
      ) : null

      const inputRow = e("div", { className: "dsh-wl-inputrow" },
        e("input", {
          className: "dsh-wl-input",
          value: input,
          onChange: ev => setInput(ev.target.value),
          onKeyDown: ev => { if (ev.key === "Enter") send() },
          placeholder: `向 ${site} 提问…`,
        }),
        e("button", { className: "dsh-wl-send", onClick: send, disabled: busy || !input.trim() }, busy ? "…" : "发送"),
      )

      const header = e("div", { className: "dsh-wl-head", onMouseDown: onDown, onMouseMove: onMove, onMouseUp: onUp, onMouseLeave: onUp },
        e("span", null,
          e("span", { className: "dsh-wl-dot", style: dot }),
          e("span", { className: "dsh-wl-dot", style: { display: "inline-block", width: 8, height: 8, borderRadius: "50%", marginRight: 6, background: health === null ? "#9aa0a6" : (health.healthy ? "#4caf50" : "#f44336") } }),
          "LLM 桥 · " + site,
        ),
        e("button", { className: "dsh-wl-btn", onClick: () => setOpen(!open), style: { border: "none", background: "none" } }, open ? "收起 ▲" : "展开 ▼"),
      )

      const healthBanner = (health !== null && !health.healthy) ? e("div", {
        style: { padding: "6px 10px", background: "#3a2222", borderBottom: "1px solid #6b3a3a", color: "#ffb4a8", fontSize: "12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
      },
        e("span", null, "⚠ 会话可能已失效（" + (health.login_redirect ? "跳转登录页" : health.error_page ? "连接错误" : "页面异常") + "）"),
        e("button", { className: "dsh-wl-btn", onClick: reconnect, disabled: busy, style: { background: "#6b3a3a", borderColor: "#8b4a4a", color: "#ffd" } }, "重新连接"),
      ) : null

      const body = open ? e("div", null,
        statusBar,
        healthBanner,
        (mode === "live" ? liveBox : logBox),
        actionRow, authPanel, inputRow,
      ) : null

      const panelStyle = { position: "fixed", zIndex: 2147482000, width: 400 }
      if (pos) { panelStyle.left = pos.x; panelStyle.top = pos.y }
      else { panelStyle.right = 16; panelStyle.bottom = 16 }

      return e("div", { className: "dsh-wl-root", style: panelStyle }, header, body)
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
          { name: "conversation.input.dock", id: "web-llm-dock" },
          WebLlmView,
        ))
      },
    }
  },
})
