#!/usr/bin/env python3
"""dsh-web-llm-bridge browser daemon.

Manages ONE active site at a time (no concurrent sites). The active site is
driven by commands.json: a {site: <name>} command switches the active context
(destroying the old one), after which {text}/{action} commands apply to the
current site.

Per-site state files:
  cookies_<site>.json / storage_state_<site>.json   auth
  live_frame_<site>.jpg                              screenshot (on demand)
  chat_log_<site>.jsonl                              conversation log
  progress_<site>.json                               long-task progress (P1-9)
  sessions_<site>.json                               named sessions (P1-6)

Environment overrides (passed by the Host plugin):
  DSH_BRIDGE_REPLY_TIMEOUT   max seconds to wait for a reply (default 180)
  DSH_BRIDGE_SEND_TIMEOUT    max seconds to wait for the message to send (default 15)
  DSH_BRIDGE_MAX_REPLY_LEN   truncate replies to this many chars (default 8000)
  DSH_BRIDGE_STABLE_POLLS    consecutive identical polls that mean "done" (default 4)
"""
import json
import os
import time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("DSH_BRIDGE_BASE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dsh-web-llm-bridge-data"))
COMMAND_FILE = os.path.join(BASE, "commands_webllm.json")
REPLY_FILE = os.path.join(BASE, "replies_webllm.json")
CDP_PORT = int(os.environ.get("DSH_BRIDGE_CDP_PORT", "9334"))
INTERVAL = 0.8

REPLY_TIMEOUT = int(os.environ.get("DSH_BRIDGE_REPLY_TIMEOUT", "180"))
SEND_TIMEOUT = int(os.environ.get("DSH_BRIDGE_SEND_TIMEOUT", "15"))
MAX_REPLY_LEN = int(os.environ.get("DSH_BRIDGE_MAX_REPLY_LEN", "8000"))
STABLE_POLLS = int(os.environ.get("DSH_BRIDGE_STABLE_POLLS", "4"))
HEALTH_INTERVAL = 60  # seconds between periodic session health probes
HEALTH_DURING_WAIT = 8  # seconds between health probes embedded in long reply waits
SCREENSHOT_ENABLED = False  # screenshot only when requested (live view on demand)

# adapter registry mirror (hosted on the JS side too; keep selectors here)
# generic site selectors are loaded from custom_sites.json at boot (P1-8)
ADAPTERS = {
    "gemini": {
        "url": "https://gemini.google.com/app",
        "editor_selectors": ["rich-textarea div.ql-editor", "div[contenteditable='true']", "textarea"],
        "reply_selectors": ["message-content"],
        "new_chat_url": "https://gemini.google.com/app",
    },
    "chatgpt": {
        "url": "https://chatgpt.com/",
        "editor_selectors": ["#prompt-textarea", "div[contenteditable='true']", "textarea[placeholder]"],
        "reply_selectors": ['[data-message-author-role="assistant"]'],
        "new_chat_url": "https://chatgpt.com/",
    },
    "doubao": {
        "url": "https://www.doubao.com/chat/",
        "editor_selectors": ["textarea[placeholder*='发消息']", "textarea", "div[contenteditable='true']"],
        "reply_selectors": ['[class*="message"]', '[class*="turn"]', '[data-testid*="message"]'],
        "new_chat_url": "https://www.doubao.com/chat/",
    },
    "generic": {
        "url": "",
        "editor_selectors": ["div[contenteditable='true']", "textarea"],
        "reply_selectors": ['[data-message-author-role="assistant"]', "message-content"],
        "new_chat_url": "",
    },
}

CUSTOM_SITES_FILE = os.path.join(BASE, "custom_sites.json")


def load_custom_sites():
    """Merge user-configured generic sites into ADAPTERS (P1-8)."""
    try:
        with open(CUSTOM_SITES_FILE, encoding="utf-8") as f:
            custom = json.load(f)
        if isinstance(custom, dict):
            for name, cfg in custom.items():
                if not isinstance(cfg, dict) or not name:
                    continue
                ADAPTERS[name] = {
                    "url": str(cfg.get("url") or ""),
                    "editor_selectors": _to_list(cfg.get("editor") or "div[contenteditable='true'], textarea"),
                    "reply_selectors": _to_list(cfg.get("reply") or '[data-message-author-role="assistant"], message-content'),
                    "send_selector": str(cfg.get("send") or ""),
                    "stop_selector": str(cfg.get("stop") or "button[aria-label*='Stop'], [data-testid='stop-button']"),
                    "new_chat_url": str(cfg.get("url") or ""),
                }
    except Exception as e:
        print(f"custom sites load failed: {e}", flush=True)


def _to_list(s):
    return [x.strip() for x in str(s).split(",") if x.strip()]


def site_files(site):
    return {
        "cookies": os.path.join(BASE, f"cookies_{site}.json"),
        "storage": os.path.join(BASE, f"storage_state_{site}.json"),
        "frame": os.path.join(BASE, f"live_frame_{site}.jpg"),
        "log": os.path.join(BASE, f"chat_log_{site}.jsonl"),
        "progress": os.path.join(BASE, f"progress_{site}.json"),
        "sessions": os.path.join(BASE, f"sessions_{site}.json"),
    }


def append_log(log_file, entry):
    try:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"log error: {e}", flush=True)


def write_progress(site, state, detail=""):
    """P1-9: write a small progress file the Host/panel can poll."""
    try:
        files = site_files(site)
        with open(files["progress"], "w") as f:
            json.dump({"site": site, "state": state, "ts": time.time(), "detail": str(detail)[:200]}, f, ensure_ascii=False)
    except Exception as e:
        print(f"progress error: {e}", flush=True)


def load_sessions(site):
    """P1-6: load named sessions for a site."""
    try:
        files = site_files(site)
        with open(files["sessions"], encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"current_id": None, "list": []}


def save_sessions(site, sessions):
    try:
        files = site_files(site)
        with open(files["sessions"], "w", encoding="utf-8") as f:
            json.dump(sessions, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"sessions save error: {e}", flush=True)


def record_session(page, site, explicit_title=None):
    """P1-6: after navigating/sending, record the current conversation as a
    named session (keyed by URL when the site uses URL-based threads)."""
    sessions = load_sessions(site)
    url = page.url
    title = (explicit_title or "").strip() or (page.title() or "").strip()[:80] or "未命名会话"
    now = time.time()
    # find existing entry with same url (thread already tracked)
    found = None
    for s in sessions["list"]:
        if s.get("url") == url:
            found = s
            break
    if found:
        found["title"] = title
        found["updated"] = now
    else:
        entry = {"id": f"sess-{int(now)}", "url": url, "title": title, "created": now, "updated": now}
        sessions["list"].append(entry)
        found = entry
    sessions["current_id"] = found["id"]
    save_sessions(site, sessions)
    return found


def find_editor(page, site):
    spec = ADAPTERS.get(site) or ADAPTERS["generic"]
    for sel in spec.get("editor_selectors") or []:
        try:
            loc = page.locator(sel).first
            if loc.count() == 0:
                continue
            if not loc.is_visible():
                continue
            # Playwright's is_visible() can miss visually-hidden fallback inputs
            # (e.g. ChatGPT's wcDTda_fallbackTextarea: 0×0, aria-hidden). Require a
            # non-zero bounding box and skip explicit hidden/fallback elements so we
            # pick the REAL composer, not the a11y fallback.
            box = loc.bounding_box()
            if not box or box.get("width", 0) < 5 or box.get("height", 0) < 5:
                continue
            try:
                hidden = loc.get_attribute("aria-hidden")
                if hidden and hidden.strip().lower() not in ("", "false", "null"):
                    continue
            except Exception:
                pass
            return loc
        except Exception:
            continue
    return None


def message_count(page, site):
    spec = ADAPTERS.get(site) or ADAPTERS["generic"]
    sels = spec.get("reply_selectors") or []
    if not sels:
        return 0
    try:
        return page.locator(sels[0]).count()
    except Exception:
        return 0


def last_message(page, site):
    spec = ADAPTERS.get(site) or ADAPTERS["generic"]
    sels = spec.get("reply_selectors") or []
    if not sels:
        return ""
    try:
        els = page.locator(sels[0])
        if els.count() == 0:
            return ""
        for i in range(els.count() - 1, -1, -1):
            txt = els.nth(i).inner_text()
            if txt and txt.strip():
                return txt
        return ""
    except Exception:
        return ""


# Completion marker: the LLM is asked to emit this exact sentence as the last
# line. Polling for it is the reliable "reply finished" signal. Natural
# language survives model rewriting better than symbol tokens.
COMPLETION_MARKER = "回答完成，请检查。"


def send_question(page, site, text, health_cb=None):
    write_progress(site, "sending")
    # The editor may render a moment after page load / site switch; retry a few
    # times instead of failing on the first probe (observed: health says editor
    # present but a send right after a switch/health probe missed it).
    editor = None
    for _ in range(6):
        editor = find_editor(page, site)
        if editor is not None:
            break
        time.sleep(2)
    if editor is None:
        write_progress(site, "error", "editor not found")
        return {"ok": False, "error": "editor not found"}
    try:
        editor.wait_for(state="visible", timeout=15000)
    except Exception:
        pass
    time.sleep(1)
    before_count = message_count(page, site)
    pre_last = last_message(page, site)
    try:
        editor.click()
        editor.fill(text)
    except Exception as e:
        write_progress(site, "error", f"fill failed: {e}")
        return {"ok": False, "error": f"fill failed: {e}"}
    time.sleep(0.5)
    spec = ADAPTERS.get(site) or ADAPTERS["generic"]
    if site == "gemini":
        editor.press("Enter")
    else:
        editor.press("Enter")
        try:
            # explicit send selector (custom sites) or generic send button
            send_sel = spec.get("send_selector")
            if send_sel:
                send_btn = page.locator(send_sel).first
                if send_btn.count() > 0 and send_btn.is_visible():
                    time.sleep(0.2)
                    send_btn.click()
            else:
                send_btn = page.locator('[data-testid="send-button"], button[aria-label*="Send"]').first
                if send_btn.count() > 0 and send_btn.is_visible():
                    time.sleep(0.2)
                    send_btn.click()
        except Exception:
            pass
    write_progress(site, "generating")
    # Wait for a NEW message (user + assistant both count) → detect failed sends
    sent_deadline = time.time() + SEND_TIMEOUT
    sent_ok = False
    while time.time() < sent_deadline:
        time.sleep(1)
        try:
            if message_count(page, site) > before_count:
                sent_ok = True
                break
        except Exception:
            continue
    if not sent_ok:
        write_progress(site, "error", "message send failed")
        return {"ok": False, "error": "message send failed (no new message appeared)"}

    # P0-3: reply completes when (a) the completion marker appears, OR (b) the
    # last message is stable for STABLE_POLLS consecutive polls. This removes
    # the fragile dependence on the model literally emitting the marker, while
    # still preferring it when present. Health probes run inline (P0-5) so the
    # daemon stays responsive during long waits.
    deadline = time.time() + REPLY_TIMEOUT
    full = ""
    stable_run = 0
    last_health_at = time.time()
    while time.time() < deadline:
        time.sleep(2)
        try:
            txt = last_message(page, site)
        except Exception:
            txt = ""
        if txt and txt.strip():
            if txt == full:
                stable_run += 1
            else:
                stable_run = 0
                full = txt
            if COMPLETION_MARKER in txt:
                break
            if stable_run >= STABLE_POLLS:
                break
        # keep the daemon's health view fresh during long replies
        if health_cb and time.time() - last_health_at > HEALTH_DURING_WAIT:
            try:
                health_cb()
                last_health_at = time.time()
            except Exception:
                pass
    if not full:
        write_progress(site, "error", "no reply within timeout")
        return {"ok": False, "error": f"no reply completed within {REPLY_TIMEOUT}s"}
    # strip the marker line and anything after it
    reply = full.split(COMPLETION_MARKER)[0].strip()
    write_progress(site, "done")
    record_session(page, site)
    return {"ok": True, "reply": reply[:MAX_REPLY_LEN]}


def run_action(page, site, action, params=None):
    global SCREENSHOT_ENABLED
    params = params or {}
    spec = ADAPTERS.get(site) or ADAPTERS["generic"]
    write_progress(site, "action", action)
    if action == "new-chat":
        url = spec.get("new_chat_url") or spec["url"]
        if not url:
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            return {"ok": True, "reply": "已刷新页面（请手动新建对话）"}
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            editor = find_editor(page, site)
            if editor is not None:
                try:
                    editor.wait_for(state="visible", timeout=20000)
                except Exception:
                    pass
            page.wait_for_timeout(2000)
            record_session(page, site)
            return {"ok": True, "reply": "已新建对话"}
        except Exception as e:
            return {"ok": False, "error": f"new-chat navigation failed: {e}"}
    if action == "stop":
        for sel in ['button[aria-label*="Stop"]', '[data-testid="stop-button"]', "button:has-text('停止')"]:
            try:
                btn = page.locator(sel).first
                if btn.count() > 0 and btn.is_visible():
                    btn.click()
                    time.sleep(1)
                    return {"ok": True, "reply": "已停止生成"}
            except Exception:
                continue
        return {"ok": True, "reply": "未发现生成中的任务（可能已停止）"}
    if action == "screenshot":
        SCREENSHOT_ENABLED = True
        return {"ok": True, "reply": "实时截图已开启"}
    if action == "no-screenshot":
        SCREENSHOT_ENABLED = False
        return {"ok": True, "reply": "实时截图已关闭"}

    # ---- P1-6 session management ----
    if action == "list-sessions":
        return {"ok": True, "sessions": load_sessions(site)}
    if action == "switch-session":
        sid = params.get("session_id") or params.get("id")
        sessions = load_sessions(site)
        target = next((s for s in sessions["list"] if s.get("id") == sid), None)
        if not target:
            return {"ok": False, "error": f"unknown session {sid}"}
        try:
            page.goto(target["url"], wait_until="domcontentloaded", timeout=60000)
            editor = find_editor(page, site)
            if editor is not None:
                try:
                    editor.wait_for(state="visible", timeout=20000)
                except Exception:
                    pass
            page.wait_for_timeout(2000)
            sessions["current_id"] = target["id"]
            save_sessions(site, sessions)
            return {"ok": True, "reply": f"已切换到会话「{target['title']}」"}
        except Exception as e:
            return {"ok": False, "error": f"switch-session failed: {e}"}
    if action == "rename-session":
        sid = params.get("session_id") or params.get("id")
        title = params.get("title", "").strip()
        sessions = load_sessions(site)
        target = next((s for s in sessions["list"] if s.get("id") == sid), None)
        if not target:
            return {"ok": False, "error": f"unknown session {sid}"}
        target["title"] = title or target["title"]
        save_sessions(site, sessions)
        return {"ok": True, "reply": f"会话已重命名为「{target['title']}」"}
    if action == "delete-session":
        sid = params.get("session_id") or params.get("id")
        sessions = load_sessions(site)
        before = len(sessions["list"])
        sessions["list"] = [s for s in sessions["list"] if s.get("id") != sid]
        if sessions["current_id"] == sid:
            sessions["current_id"] = sessions["list"][0]["id"] if sessions["list"] else None
        save_sessions(site, sessions)
        return {"ok": True, "reply": f"已删除会话（{before - len(sessions['list'])} 条）"}

    # ---- NEW: debug / research capability ----
    if action == "eval":
        expression = params.get("expression", "")
        if not expression:
            return {"ok": False, "error": "expression required"}
        try:
            result = page.evaluate(expression)
            return {"ok": True, "result": result, "reply": "eval ok"}
        except Exception as e:
            return {"ok": False, "error": f"eval failed: {e}"}
    if action == "get-dom":
        # dump a compact summary of the page: buttons, key labels, current URL
        try:
            result = page.evaluate("""() => {
                const out = { url: location.href, title: document.title };
                const grab = (sel) => {
                    const els = [...document.querySelectorAll(sel)];
                    return els.slice(0, 12).map(e => (e.textContent || '').trim().slice(0, 60)).filter(Boolean);
                };
                out.buttons = grab('button');
                out.composerText = grab('[class*="composer"] button, [data-testid*="composer"] button');
                out.editor = (document.querySelector('#prompt-textarea, textarea[placeholder], div[contenteditable="true"]') || {}).getAttribute ? 'present' : 'none';
                return out;
            }""")
            return {"ok": True, "result": result, "reply": "dom dumped"}
        except Exception as e:
            return {"ok": False, "error": f"get-dom failed: {e}"}
    # ---- NEW: generic UI drive (for model/thinking controls etc.) ----
    if action == "click":
        selector = params.get("selector", "")
        testid = params.get("testid", "")
        text = params.get("text", "")
        role = params.get("role", "")
        loc = None
        try:
            if selector:
                loc = page.locator(selector).first
            elif testid:
                loc = page.locator(f'[data-testid="{testid}"]').first
            elif role:
                loc = page.get_by_role(role, name=params.get("name", "")).first
            elif text:
                loc = page.get_by_text(text, exact=bool(params.get("exact"))).first
            if loc is None or loc.count() == 0 or not loc.is_visible():
                return {"ok": False, "error": "click target not found"}
            loc.click()
            time.sleep(0.5)
            return {"ok": True, "reply": "已点击"}
        except Exception as e:
            return {"ok": False, "error": f"click failed: {e}"}
    if action == "reload-config":
        load_custom_sites()
        return {"ok": True, "reply": "配置已重载"}
    return {"ok": False, "error": f"unknown action {action}"}


def load_auth(ctx, site):
    files = site_files(site)
    if os.path.exists(files["storage"]):
        try:
            ctx.storage_state(path=files["storage"])
            return {"source": "storage_state"}
        except Exception as e:
            print(f"storage load failed: {e}", flush=True)
    if os.path.exists(files["cookies"]):
        try:
            cookies = json.load(open(files["cookies"]))
            if isinstance(cookies, list) and len(cookies) > 0:
                ctx.add_cookies(cookies)
                return {"source": "cookies", "count": len(cookies)}
        except Exception as e:
            print(f"cookies load failed: {e}", flush=True)
    return {"source": "none"}


def main():
    load_custom_sites()
    # default site at boot: DSH_BRIDGE_DEFAULT_SITE env (Host passes
    # config.defaultSite / DSH_BRIDGE_DEFAULT_SITE), falling back to chatgpt.
    # A stale COMMAND_FILE site is NOT honored — the Host decides the active
    # site at startup so the panel and daemon stay in sync.
    active_site = os.environ.get("DSH_BRIDGE_DEFAULT_SITE", "chatgpt")

    headless = os.environ.get("DSH_HEADLESS", "1") != "0"
    print(f"BROWSER MODE headless={headless} display={os.environ.get('DISPLAY', '(none)')} "
          f"reply_timeout={REPLY_TIMEOUT} max_len={MAX_REPLY_LEN} stable_polls={STABLE_POLLS}", flush=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=headless,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                f"--remote-debugging-port={CDP_PORT}",
            ],
        )

        def create_context(site):
            ctx = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                ),
                locale="zh-CN",
                viewport={"width": 1280, "height": 860},
                device_scale_factor=2,
            )
            auth = load_auth(ctx, site)
            page = ctx.new_page()
            url = ADAPTERS.get(site, {}).get("url")
            if url:
                for attempt in range(3):
                    try:
                        page.goto(url, wait_until="domcontentloaded", timeout=45000)
                        break
                    except Exception as e:
                        print(f"nav attempt {attempt+1} failed: {str(e)[:80]}", flush=True)
                        time.sleep(5)
                try:
                    editor = find_editor(page, site)
                    if editor is not None:
                        editor.wait_for(state="visible", timeout=25000)
                except Exception:
                    pass
                page.wait_for_timeout(2000)
            files = site_files(site)
            logged_in = True
            if site == "gemini":
                logged_in = "accounts.google.com" not in page.url
            elif site == "chatgpt":
                logged_in = "auth.openai.com" not in page.url
            status = {"source": auth.get("source"), "logged_in": logged_in, "url": page.url}
            with open(os.path.join(BASE, f"auth_status_{site}.json"), "w") as f:
                json.dump(status, f, ensure_ascii=False)
            record_session(page, site)
            print(f"SITE {site} READY cdp={CDP_PORT} url={page.url} logged_in={logged_in}", flush=True)
            return ctx, page

        ctx, page = create_context(active_site)
        if os.path.exists(REPLY_FILE):
            os.remove(REPLY_FILE)
        last_cmd = None
        last_site = active_site
        last_health_check = time.time()

        def check_health():
            try:
                url = page.url
                title = page.title()
                error = url.startswith("chrome-error://")
                login = False
                if last_site == "gemini":
                    login = "accounts.google.com" in url
                elif last_site == "chatgpt":
                    login = "auth.openai.com" in url
                elif last_site == "doubao":
                    login = "passport" in url or "login" in url
                editor_ok = find_editor(page, last_site) is not None
                status = {
                    "site": last_site,
                    "ts": time.time(),
                    "healthy": (not error) and (not login) and editor_ok,
                    "error_page": error,
                    "login_redirect": login,
                    "editor_present": editor_ok,
                    "url": url,
                    "title": title[:60],
                }
                with open(os.path.join(BASE, "health_status.json"), "w") as f:
                    json.dump(status, f, ensure_ascii=False)
                return status
            except Exception as e:
                return {"site": last_site, "ts": time.time(), "healthy": False, "error": str(e)[:100]}

        try:
            while True:
                if time.time() - last_health_check > HEALTH_INTERVAL:
                    check_health()
                    last_health_check = time.time()

                if SCREENSHOT_ENABLED:
                    try:
                        page.screenshot(path=site_files(last_site)["frame"], type="jpeg", quality=65)
                    except Exception as e:
                        print(f"shot error: {e}", flush=True)

                if os.path.exists(COMMAND_FILE):
                    try:
                        with open(COMMAND_FILE) as f:
                            cmd = json.load(f)
                        if cmd.get("id") != last_cmd:
                            last_cmd = cmd["id"]
                            if (cmd.get("site") and cmd["site"] != last_site) or cmd.get("reconnect"):
                                target = cmd.get("site") or last_site
                                try:
                                    ctx.close()
                                except Exception:
                                    pass
                                last_site = target
                                ctx, page = create_context(last_site)
                                # A pure switch/reconnect command (no text/action) is answered with the
                                # confirmation and done; a switch that also carries text/action falls
                                # through so consult_llm can switch site AND get its answer in one call.
                                if not cmd.get("text") and not cmd.get("action") and not cmd.get("healthCheck"):
                                    with open(REPLY_FILE, "w") as f:
                                        json.dump({"id": cmd["id"], "ok": True, "reply": f"已重新连接 {last_site}"}, f, ensure_ascii=False)
                                    os.remove(COMMAND_FILE)
                                    continue
                            if cmd.get("healthCheck"):
                                h = check_health()
                                with open(REPLY_FILE, "w") as f:
                                    json.dump({"id": cmd["id"], "ok": True, "reply": "health checked", "health": h}, f, ensure_ascii=False)
                                os.remove(COMMAND_FILE)
                                continue
                            desc = cmd.get("text") or cmd.get("action") or "?"
                            print(f"CMD {cmd['id']} [{last_site}]: {desc[:80]}", flush=True)
                            result = handle_command(page, last_site, cmd)
                            with open(REPLY_FILE, "w") as f:
                                json.dump({"id": cmd["id"], **result}, f, ensure_ascii=False)
                            append_log(site_files(last_site)["log"], {
                                "ts": time.time(),
                                "id": cmd["id"],
                                "kind": "action" if cmd.get("action") else "chat",
                                "question": cmd.get("text", ""),
                                "action": cmd.get("action", ""),
                                "fresh": bool(cmd.get("fresh", False)),
                                "ok": result.get("ok"),
                                "reply": result.get("reply", ""),
                                "error": result.get("error", ""),
                            })
                            os.remove(COMMAND_FILE)
                            print(f"DONE {cmd['id']} ok={result.get('ok')}", flush=True)
                    except Exception as e:
                        print(f"cmd error: {e}", flush=True)

                time.sleep(INTERVAL)
        except KeyboardInterrupt:
            print("stopping", flush=True)
        finally:
            browser.close()


def handle_command(page, site, cmd):
    if cmd.get("fresh"):
        res = run_action(page, site, "new-chat")
        if not res.get("ok"):
            return res
        return send_question(page, site, cmd["text"]) if cmd.get("text") else {"ok": True, "reply": "已新建对话"}
    if cmd.get("text"):
        return send_question(page, site, cmd["text"])
    if cmd.get("action"):
        return run_action(page, site, cmd["action"], params=cmd.get("params") or {})
    return {"ok": False, "error": "command has no text or action"}


if __name__ == "__main__":
    main()
