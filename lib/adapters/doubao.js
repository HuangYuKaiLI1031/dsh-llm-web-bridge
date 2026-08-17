// Doubao (豆包) site adapter — byte-dance's web LLM at www.doubao.com/chat/
// Editor is a plain <textarea> (placeholder "发消息..."), Enter sends.

export const doubaoAdapter = {
  name: 'doubao',
  label: '豆包',
  url: 'https://www.doubao.com/chat/',
  cookieDomains: ['.doubao.com', '.www.doubao.com'],
  frameFile: 'live_frame_doubao.jpg',
  logFile: 'chat_log_doubao.jsonl',

  findEditor(page) {
    for (const sel of ["textarea[placeholder*='发消息']", 'textarea', "div[contenteditable='true']"]) {
      try {
        const loc = page.locator(sel).first
        if (loc.count() > 0 && loc.is_visible()) return loc
      } catch (e) { /* try next */ }
    }
    return null
  },

  send(page, editor) {
    editor.press('Enter')
  },

  messageCount(page) {
    // Doubao messages live in scrollable turn containers; count paragraphs
    // with role=user/assistant-like markers is fragile — count textarea's
    // sibling conversation blocks via a broad selector.
    try { return page.locator('[class*="message"], [class*="turn"], [data-testid*="message"]').count() } catch (e) { return 0 }
  },

  lastMessage(page) {
    try {
      // prefer the last non-empty text block inside the conversation
      const candidates = page.locator('[class*="message"], [class*="turn"], [data-testid*="message"]')
      if (candidates.count() === 0) return ''
      for (let i = candidates.count() - 1; i >= 0; i--) {
        const t = candidates.nth(i).inner_text()
        if (t && t.trim()) return t
      }
      return ''
    } catch (e) { return '' }
  },

  async newChat(page) {
    await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    try {
      const editor = this.findEditor(page)
      if (editor) await editor.waitFor({ state: 'visible', timeout: 20000 })
    } catch (e) { /* may be slow */ }
    await page.waitForTimeout(2000)
    return { ok: true, reply: '已新建对话' }
  },

  async detectLogin(page) {
    const url = page.url()
    if (url.includes('passport') || url.includes('login')) return false
    try {
      const editor = this.findEditor(page)
      return editor !== null && editor.isVisible()
    } catch (e) { return false }
  },

  async stop(page) {
    try {
      const btn = page.locator('[class*="stop"], button:has-text("停止")').first
      if (btn.count() > 0 && btn.isVisible()) {
        await btn.click()
        await page.waitForTimeout(500)
        return { ok: true, reply: '已停止生成' }
      }
    } catch (e) { /* nothing */ }
    return { ok: true, reply: '未发现生成中的任务' }
  },
}
