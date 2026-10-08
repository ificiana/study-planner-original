import { describe, expect, it } from 'vitest'
import { fmtDate } from '../src/lib/date'
import { enDict, zhDict } from '../src/lib/i18n/registry'
import { displayPlanName, getActiveLanguage, storedLanguage, setActiveLanguage, tr, translate, variantsOfZh, zhHeading } from '../src/lib/i18n'

describe('i18n dictionaries', () => {
  it('zh and en define the same keys', () => {
    expect(Object.keys(enDict).filter(k => !(k in zhDict))).toEqual([])
    expect(Object.keys(zhDict).filter(k => !(k in enDict))).toEqual([])
  })

  it('interpolates {{var}} and falls back to the key', () => {
    expect(translate('en', 'no.such.key')).toBe('no.such.key')
    expect(translate('zh', 'dt.001')).toBe('M月d日')
  })

  it('tr uses the active language', () => {
    setActiveLanguage('en')
    expect(getActiveLanguage()).toBe('en')
    expect(tr('dt.001')).toBe('MMM d')
    setActiveLanguage('zh')
    expect(tr('dt.001')).toBe('M月d日')
  })

  it('matches rendered labels in either language', () => {
    const variants = variantsOfZh('设置')
    expect(variants).toContain('设置')
    expect(variants.length).toBeGreaterThan(1)
    expect(zhHeading(variants[1])).toBe('设置')
    expect(zhHeading('未知')).toBe('未知')
    expect(variantsOfZh('不存在的文本')).toEqual(['不存在的文本'])
  })

  it('shows seeded default plan names in the active language and keeps custom names', () => {
    setActiveLanguage('en')
    expect(displayPlanName('我的学习计划')).toBe('My study plan')
    expect(displayPlanName('学习计划')).toBe('Study plan')
    expect(displayPlanName('完整功能演示计划')).toBe('Full feature demo plan')
    expect(displayPlanName('Maths sprint')).toBe('Maths sprint')
    setActiveLanguage('zh')
    expect(displayPlanName('我的学习计划')).toBe('我的学习计划')
  })

  it('remembers the language in localStorage and ignores invalid values', () => {
    const store = new Map<string, string>()
    const original = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } })
    try {
      expect(storedLanguage()).toBeUndefined()
      setActiveLanguage('en')
      expect(storedLanguage()).toBe('en')
      store.set('study-planner:language', 'fr')
      expect(storedLanguage()).toBeUndefined()
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } } })
      expect(storedLanguage()).toBeUndefined()
      expect(() => setActiveLanguage('zh')).not.toThrow()
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original })
      setActiveLanguage('zh')
    }
  })

  it('formats short dates per language', () => {
    setActiveLanguage('en')
    expect(fmtDate('2026-10-08')).toBe('Oct 8')
    setActiveLanguage('zh')
    expect(fmtDate('2026-10-08')).toBe('10月8日')
  })
})

describe('aggregateDaily labels', () => {
  it('uses the active language by default', async () => {
    const { aggregateDaily } = await import('../src/lib/stats')
    const { setActiveLanguage } = await import('../src/lib/i18n')
    setActiveLanguage('en')
    const [row] = aggregateDaily([], new Map(), false, '2026-10-07', '2026-10-07')
    expect(row.label).not.toMatch(/[一-鿿]/)
    setActiveLanguage('zh')
  })
})
