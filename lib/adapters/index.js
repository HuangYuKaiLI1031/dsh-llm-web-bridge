// Site adapter registry: the single place to enumerate supported sites.
// Adding a site = add an adapter file + register it here.

import { geminiAdapter } from './gemini.js'
import { chatgptAdapter } from './chatgpt.js'
import { doubaoAdapter } from './doubao.js'
import { genericAdapter } from './generic.js'

export const ADAPTERS = {
  gemini: geminiAdapter,
  chatgpt: chatgptAdapter,
  doubao: doubaoAdapter,
  generic: genericAdapter,
}

export function getAdapter(name) {
  return ADAPTERS[name] || null
}

export function listAdapters() {
  return Object.values(ADAPTERS).map(a => ({
    name: a.name,
    label: a.label,
    url: a.url,
  }))
}
