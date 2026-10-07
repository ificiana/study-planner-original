import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import type { AppSettings } from '../../types'
import type { Primitive } from './types'
import { zhDict, enDict } from './registry'

export type Language = AppSettings['language']

const dictionaries: Record<Language, Record<string, string>> = { zh: zhDict, en: enDict }

function interpolate(template: string, vars?: Record<string, Primitive>): string {
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in vars ? String(vars[key]) : match))
}

/** Falls back to zh, then to the raw key, so a missing translation never crashes the UI. */
export function translate(language: Language, key: string, vars?: Record<string, Primitive>): string {
  const dict = dictionaries[language] ?? zhDict
  const template = dict[key] ?? zhDict[key] ?? key
  return interpolate(template, vars)
}

const LANGUAGE_STORAGE_KEY = 'study-planner:language'

/** The language remembered in this browser, if any; storage may be unavailable (private mode, SSR). */
export function storedLanguage(): Language | undefined {
  try {
    const value = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY)
    return value === 'zh' || value === 'en' ? value : undefined
  } catch {
    return undefined
  }
}

let activeLanguage: Language = storedLanguage() ?? 'zh'

export function setActiveLanguage(language: Language) {
  activeLanguage = language
  try {
    if (globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY) !== language) globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // storage unavailable: the language still applies for this session
  }
}

export function getActiveLanguage(): Language {
  return activeLanguage
}

/** Translates with the language the app is currently showing; for non-React code that has no `t`. */
export function tr(key: string, vars?: Record<string, Primitive>): string {
  return translate(activeLanguage, key, vars)
}

/** Both language variants of a label, for code that matches rendered DOM text regardless of locale. */
export function labelVariants(key: string): string[] {
  return [translate('zh', key), translate('en', key)]
}

let zhIndex: Map<string, string[]> | undefined
/** Every zh/en rendering of a UI label, found by its zh text; for matching rendered DOM text in either language. */
export function variantsOfZh(zh: string): string[] {
  if (!zhIndex) {
    zhIndex = new Map()
    for (const [key, value] of Object.entries(zhDict)) {
      const list = zhIndex.get(value) ?? [value]
      const en = enDict[key]
      if (en && !list.includes(en)) list.push(en)
      zhIndex.set(value, list)
    }
  }
  return zhIndex.get(zh) ?? [zh]
}

/** Maps rendered label text in either language back to its zh text (unchanged when unknown). */
export function zhHeading(text: string): string {
  variantsOfZh('')
  for (const [zh, list] of zhIndex ?? []) if (list.includes(text)) return zh
  return text
}

const DEFAULT_PLAN_NAME_KEYS: Record<string, string> = {
  '学习计划': 'plan.defaultName',
  '我的学习计划': 'plan.myName',
  '完整功能演示计划': 'plan.demoName',
}

/** Shows the seeded default plan names in the active language; custom names pass through unchanged. */
export function displayPlanName(name: string): string {
  const key = DEFAULT_PLAN_NAME_KEYS[name]
  return key ? tr(key) : name
}

interface I18nContextValue {
  language: Language
  t: (key: string, vars?: Record<string, Primitive>) => string
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined)

export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  setActiveLanguage(language)
  const t = useCallback((key: string, vars?: Record<string, Primitive>) => translate(language, key, vars), [language])
  const value = useMemo(() => ({ language, t }), [language, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (ctx) return ctx
  const language = getActiveLanguage()
  return { language, t: (key: string, vars?: Record<string, Primitive>) => translate(language, key, vars) }
}

export function useT() {
  return useI18n().t
}
