#!/usr/bin/env python3
"""dsh-llm-web-bridge smoke test.

CI-safe: validates the daemon module loads, its adapter registry is complete,
and (when a Playwright browser is available) that a headless Chromium can
actually launch and navigate. Skippable — set DSH_BRIDGE_SKIP_BROWSER=1 to skip
the browser part (e.g. CI without a browser install).

Usage:
    python3 daemon/smoke_test.py
"""
import ast
import importlib.util
import os
import sys

FAILURES = []


def check(name, fn):
    try:
        fn()
        print(f"  ok: {name}")
    except Exception as e:
        FAILURES.append((name, e))
        print(f"  FAIL: {name}: {e}")


def test_module_parses():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "browser_daemon_webllm.py")
    with open(path) as f:
        ast.parse(f.read())


def test_module_imports():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "browser_daemon_webllm.py")
    spec = importlib.util.spec_from_file_location("bridge_daemon_mod", path)
    mod = importlib.util.module_from_spec(spec)
    # module imports playwright at top level; stub it if unavailable so we can
    # still validate the registry and constants without the package installed.
    try:
        import playwright  # noqa: F401
        spec.loader.exec_module(mod)
    except ImportError:
        import types
        fake = types.ModuleType("playwright")
        fake.sync_api = types.ModuleType("playwright.sync_api")
        fake.sync_api.sync_playwright = lambda: None
        sys.modules["playwright"] = fake
        sys.modules["playwright.sync_api"] = fake.sync_api
        spec.loader.exec_module(mod)
    assert hasattr(mod, "ADAPTERS"), "ADAPTERS registry missing"
    for site in ("gemini", "chatgpt", "doubao", "generic"):
        assert site in mod.ADAPTERS, f"missing adapter {site}"
    assert mod.COMPLETION_MARKER, "completion marker missing"
    assert mod.REPLY_TIMEOUT >= 30, "reply timeout too small"
    assert mod.MAX_REPLY_LEN >= 1000, "max reply len too small"


def test_browser_launch():
    if os.environ.get("DSH_BRIDGE_SKIP_BROWSER") == "1":
        print("  skip: DSH_BRIDGE_SKIP_BROWSER=1")
        return
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page()
        page.goto("about:blank")
        assert page.evaluate("() => 1 + 1") == 2
        browser.close()


if __name__ == "__main__":
    print("smoke test: dsh-llm-web-bridge daemon")
    check("module parses", test_module_parses)
    check("module imports + adapter registry", test_module_imports)
    check("headless chromium launch + evaluate", test_browser_launch)
    if FAILURES:
        print(f"\n{len(FAILURES)} FAILURE(S)")
        for name, err in FAILURES:
            print(f"  - {name}: {err}")
        sys.exit(1)
    print("\nall smoke checks passed")
