import type { Dict } from './types'

// Every file under ./dicts/*.ts must export `zh: Dict` and `en: Dict`.
// New domains are picked up automatically — no manual registration needed,
// which lets multiple translators add dictionary files without merge conflicts.
const modules = import.meta.glob<{ zh: Dict; en: Dict }>('./dicts/*.ts', { eager: true })

function mergeAll(pick: 'zh' | 'en'): Dict {
  const merged: Dict = {}
  for (const path of Object.keys(modules).sort()) {
    const mod = modules[path]
    const part = mod[pick]
    if (!part) continue
    for (const key of Object.keys(part)) {
      if (import.meta.env.DEV && key in merged) {
        // eslint-disable-next-line no-console
        console.warn(`[i18n] duplicate key "${key}" in ${path} (${pick})`)
      }
      merged[key] = part[key]
    }
  }
  return merged
}

export const zhDict: Dict = mergeAll('zh')
export const enDict: Dict = mergeAll('en')
