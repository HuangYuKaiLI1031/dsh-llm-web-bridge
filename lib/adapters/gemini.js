// Gemini site adapter — the reference implementation of the SiteAdapter
// interface. All Gemini-specific selectors and behaviors live here.

export const geminiAdapter = {
  name: 'gemini',
  label: 'Gemini',
  url: 'https://gemini.google.com/app',
  cookieDomains: ['.google.com'],
  frameFile: 'live_frame_gemini.jpg',
  logFile: 'chat_log_gemini.jsonl',

  // ---- editor / send ----
  findEditor(page) {
    for (const sel of ["rich-textarea div.ql-editor", "div[contenteditable='true']", "textarea"]) {
      try {
        const loc = page.locator(sel).first
        if (loc.count() > 0 && loc.is_visible()) return loc
      } catch (e) { /* try next */ }
    }
    return null
  },

  send(page, editor) {
    // Enter sends on Gemini; no separate send button needed.
    editor.press('Enter')
  },

  // ---- reply extraction ----
  messageCount(page) {
    try { return page.locator('message-content').count() } catch (e) { return 0 }
  },

  lastMessage(page) {
    try {
      const els = page.locator('message-content')
      if (els.count() === 0) return ''
      return els.nth(els.count() - 1).inner_text()
    } catch (e) { return '' }
  },

  // ---- new chat ----
  async newChat(page) {
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 })
    const editor = this.findEditor(page)
    if (editor !== null) {
      try { await editor.waitFor({ state: 'visible', timeout: 15000 }) } catch (e) { /* app may be slow */ }
    }
    await page.waitForTimeout(1500)
    return { ok: true, reply: '已新建对话' }
  },

  // ---- login detection ----
  async detectLogin(page) {
    return !page.url().includes('accounts.google.com')
  },

  // ---- stop generation ----
  async stop(page) {
    for (const name of ['Stop', '停止', '停止生成']) {
      try {
        const btn = page.getByRole('button', { name }).first
        if (btn.count() > 0 && btn.is_visible()) {
          await btn.click()
          await page.waitForTimeout(1000)
          return { ok: true, reply: '已停止生成' }
        }
      } catch (e) { /* try next */ }
    }
    return { ok: true, reply: '未发现生成中的任务（可能已停止）' }
  },
}
