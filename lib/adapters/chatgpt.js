// ChatGPT site adapter (chatgpt.com).
// NOTE: ChatGPT is behind Cloudflare; a real browser passes the JS challenge
// but selectors may need updating as OpenAI changes the UI. This adapter is
// the P3 target; structure follows the known chatgpt.com layout.

export const chatgptAdapter = {
  name: 'chatgpt',
  label: 'ChatGPT',
  url: 'https://chatgpt.com/',
  cookieDomains: ['chatgpt.com', '.chatgpt.com', '.openai.com'],
  frameFile: 'live_frame_chatgpt.jpg',
  logFile: 'chat_log_chatgpt.jsonl',

  findEditor(page) {
    for (const sel of ["#prompt-textarea", "div[contenteditable='true']", "textarea[placeholder]"]) {
      try {
        const loc = page.locator(sel).first
        if (loc.count() > 0 && loc.is_visible()) return loc
      } catch (e) { /* try next */ }
    }
    return null
  },

  async send(page, editor) {
    await editor.press('Enter')
    // fallback: click the send button if present
    try {
      const sendBtn = page.locator('[data-testid="send-button"], button[aria-label*="Send"]').first
      if (sendBtn.count() > 0 && sendBtn.isVisible()) {
        await page.waitForTimeout(200)
        await sendBtn.click()
      }
    } catch (e) { /* Enter already sent */ }
  },

  messageCount(page) {
    try { return page.locator('[data-message-author-role="assistant"]').count() } catch (e) { return 0 }
  },

  lastMessage(page) {
    try {
      const els = page.locator('[data-message-author-role="assistant"]')
      if (els.count() === 0) return ''
      return els.nth(els.count() - 1).inner_text()
    } catch (e) { return '' }
  },

  async newChat(page) {
    // navigate to bare / to get a fresh conversation
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    try {
      const editor = this.findEditor(page)
      if (editor) await editor.waitFor({ state: 'visible', timeout: 20000 })
    } catch (e) { /* may need longer */ }
    await page.waitForTimeout(2000)
    return { ok: true, reply: '已新建对话' }
  },

  async detectLogin(page) {
    const url = page.url()
    if (url.includes('auth.openai.com')) return false
    try {
      const editor = this.findEditor(page)
      return editor !== null && editor.isVisible()
    } catch (e) { return false }
  },

  async stop(page) {
    try {
      const btn = page.locator('[data-testid="stop-button"], button[aria-label*="Stop"]').first
      if (btn.count() > 0 && btn.isVisible()) {
        await btn.click()
        await page.waitForTimeout(500)
        return { ok: true, reply: '已停止生成' }
      }
    } catch (e) { /* nothing generating */ }
    return { ok: true, reply: '未发现生成中的任务' }
  },
}
