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
SCREENSHOT_ENABLED = False  # screenshot only when requested (live view on demand)

# adapter registry mirror (hosted on the JS side too; keep selectors here)
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


def site_files(site):
    return {
        "cookies": os.path.join(BASE, f"cookies_{site}.json"),
        "storage": os.path.join(BASE, f"storage_state_{site}.json"),
        "frame": os.path.join(BASE, f"live_frame_{site}.jpg"),
        "log": os.path.join(BASE, f"chat_log_{site}.jsonl"),
    }


def append_log(log_file, entry):
    try:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"log error: {e}", flush=True)


def find_editor(page, site):
    for sel in ADAPTERS[site]["editor_selectors"]:
        try:
            loc = page.locator(sel).first
            if loc.count() > 0 and loc.is_visible():
                return loc
        except Exception:
            continue
    return None


def message_count(page, site):
    try:
        return page.locator(ADAPTERS[site]["reply_selectors"][0]).count()
    except Exception:
        return 0


def last_message(page, site):
    try:
        els = page.locator(ADAPTERS[site]["reply_selectors"][0])
        if els.count() == 0:
            return ""
        # return the LAST NON-EMPTY assistant message (streaming renders empties)
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


def send_question(page, site, text):
    editor = find_editor(page, site)
    if editor is None:
        return {"ok": False, "error": "editor not found"}
    try:
        editor.wait_for(state="visible", timeout=15000)
    except Exception:
        pass
    time.sleep(1)
    # capture message count + last reply BEFORE sending
    before_count = message_count(page, site)
    pre_last = last_message(page, site)
    editor.click()
    editor.fill(text)
    time.sleep(0.5)
    if site == "gemini":
        editor.press("Enter")
    else:
        editor.press("Enter")
        try:
            send_btn = page.locator('[data-testid="send-button"], button[aria-label*="Send"]').first
            if send_btn.count() > 0 and send_btn.is_visible():
                time.sleep(0.2)
                send_btn.click()
        except Exception:
            pass
    # First wait for a NEW message to appear (user + assistant both count), so a
    # failed send is detected quickly instead of misreading old replies.
    sent_deadline = time.time() + 15
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
        return {"ok": False, "error": "message send failed (no new message appeared)"}
    # Poll until the completion marker appears (or timeout). The marker is the
    # authoritative "reply finished" signal, so streaming partial content is
    # never mistaken for the final answer.
    deadline = time.time() + 60
    full = ""
    while time.time() < deadline:
        time.sleep(2)
        try:
            txt = last_message(page, site)
            if txt and txt.strip():
                full = txt
                if COMPLETION_MARKER in txt:
                    break
        except Exception:
            continue
    if not full or COMPLETION_MARKER not in full:
        # fallback: if no marker but the LAST message changed vs pre-send, accept
        if full and full != pre_last:
            return {"ok": True, "reply": full.replace(COMPLETION_MARKER, "").strip()[:3000]}
        return {"ok": False, "error": "no reply completed within 60s (marker not seen)"}
    # strip the marker line and anything after it
    reply = full.split(COMPLETION_MARKER)[0].strip()
    return {"ok": True, "reply": reply[:3000]}


def run_action(page, site, action):
    global SCREENSHOT_ENABLED
    spec = ADAPTERS[site]
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
    active_site = "gemini"  # default site at boot
    if os.path.exists(COMMAND_FILE):
        try:
            boot = json.load(open(COMMAND_FILE))
            if boot.get("site"):
                active_site = boot["site"]
        except Exception:
            pass

    headless = os.environ.get("DSH_HEADLESS", "1") != "0"
    print(f"BROWSER MODE headless={headless} display={os.environ.get('DISPLAY', '(none)')}", flush=True)
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
            url = ADAPTERS[site]["url"]
            if url:
                # retry navigation up to 3 times — Cloudflare intermittently
                # drops headless connections on first load
                for attempt in range(3):
                    try:
                        page.goto(url, wait_until="domcontentloaded", timeout=45000)
                        break
                    except Exception as e:
                        print(f"nav attempt {attempt+1} failed: {str(e)[:80]}", flush=True)
                        time.sleep(5)
                # wait for the editor to become visible (SPA load / challenge pass)
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
            print(f"SITE {site} READY cdp={CDP_PORT} url={page.url} logged_in={logged_in}", flush=True)
            return ctx, page

        ctx, page = create_context(active_site)
        if os.path.exists(REPLY_FILE):
            os.remove(REPLY_FILE)
        last_cmd = None
        last_site = active_site
        last_health_check = time.time()
        HEALTH_INTERVAL = 60  # seconds between session health probes

        def check_health():
            """Lightweight session health probe: detect if the page drifted to
            a login screen or threw an error page. Does NOT reload (avoid
            triggering anti-bot); just inspects the current page state."""
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
                # periodic session health probe
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
                            # site switch or forced reconnect (rebuild context to
                            # pick up fresh cookies even for the current site)
                            if (cmd.get("site") and cmd["site"] != last_site) or cmd.get("reconnect"):
                                target = cmd.get("site") or last_site
                                try:
                                    ctx.close()
                                except Exception:
                                    pass
                                last_site = target
                                ctx, page = create_context(last_site)
                                with open(REPLY_FILE, "w") as f:
                                    json.dump({"id": cmd["id"], "ok": True, "reply": f"已重新连接 {last_site}"}, f, ensure_ascii=False)
                                os.remove(COMMAND_FILE)
                                continue
                            if cmd.get("healthCheck"):
                                # immediate health probe requested by the Host
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
        return run_action(page, site, cmd["action"])
    return {"ok": False, "error": "command has no text or action"}


if __name__ == "__main__":
    main()
