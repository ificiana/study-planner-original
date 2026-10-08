import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dir = new URL('../src/', import.meta.url)
const cjkContent = /([^{}]+)\{[^{}]*?content:\s*(['"])[^'"]*[一-鿿][^'"]*\2/g

describe('CSS generated labels', () => {
  it('every Chinese ::before/::after label has an English override', () => {
    const files = readdirSync(dir).filter(f => f.endsWith('.css') && f !== 'i18n-content.css')
    const selectors = files.flatMap(f => [...readFileSync(new URL(f, dir), 'utf8').matchAll(cjkContent)].map(m => m[1].trim().split('/').pop()!.trim()))
    const overrides = readFileSync(new URL('i18n-content.css', dir), 'utf8')
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) expect(overrides).toContain(`html[lang="en"] ${selector}{`)
  })
})
