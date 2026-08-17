// Generic site adapter — lets users bring ANY web LLM by configuring
// CSS selectors in the panel (or a config file). All selectors are overridable.

export const genericAdapter = {
  name: 'generic',
  label: '自定义（通用）',
  url: '',
  cookieDomains: [],
  frameFile: 'live_frame_generic.jpg',
  logFile: 'chat_log_generic.jsonl',

  // selectors are configured at runtime via config.selectors
  _sel(config, key, fallback) {
    return (config && config.selectors && config.selectors[key]) || fallback
  },

  findEditor(page, config) {
    const editorSel = this._sel(config, 'editor', "div[contenteditable='true'], textarea")
    for (const sel of editorSel.split(',').map(s => s.trim()).filter(Boolean)) {
      try {
        const loc = page.locator(sel).first
        if (loc.count() > 0 && loc.is_visible()) return loc
      } catch (e) { /* try next */ }
    }
    return null
  },

  async send(page, editor, config) {
    const sendSel = this._sel(config, 'send', '')
    await editor.press('Enter')
    if (sendSel) {
      try {
        const btn = page.locator(sendSel).first
        if (btn.count() > 0 && btn.isVisible()) {
          await page.waitForTimeout(200)
          await btn.click()
        }
      } catch (e) { /* Enter already sent */ }
    }
  },

  messageCount(page, config) {
    const replySel = this._sel(config, 'reply', '[data-message-author-role="assistant"], message-content')
    try { return page.locator(replySel.split(',')[0].trim()).count() } catch (e) { return 0 }
  },

  lastMessage(page, config) {
    const replySel = this._sel(config, 'reply', '[data-message-author-role="assistant"], message-content')
    const sel = replySel.split(',').map(s => s.trim()).filter(Boolean)[0]
    if (!sel) return ''
    try {
      const els = page.locator(sel)
      if (els.count() === 0) return ''
      return els.nth(els.count() - 1).inner_text()
    } catch (e) { return '' }
  },

  async newChat(page, config) {
    const url = this._sel(config, 'url', '')
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      try {
        const editor = this.findEditor(page, config)
        if (editor) await editor.waitFor({ state: 'visible', timeout: 20000 })
      } catch (e) { /* may need longer */ }
      await page.waitForTimeout(2000)
      return { ok: true, reply: '已新建对话' }
    }
    // no url configured — reload current page as a new-chat best effort
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    return { ok: true, reply: '已刷新页面（请手动新建对话）' }
  },

  async detectLogin(page) {
    return true // generic: assume logged in unless editor missing
  },

  async stop(page, config) {
    const stopSel = this._sel(config, 'stop', 'button[aria-label*="Stop"], [data-testid="stop-button"]')
    if (stopSel) {
      try {
        const btn = page.locator(stopSel).first
        if (btn.count() > 0 && btn.isVisible()) {
          await btn.click()
          await page.waitForTimeout(500)
          return { ok: true, reply: '已停止生成' }
        }
      } catch (e) { /* nothing generating */ }
    }
    return { ok: true, reply: '未发现生成中的任务' }
  },
}
