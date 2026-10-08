import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255) }
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const token = (css: string, name: string) => [...css.matchAll(new RegExp(`${name}:(#[0-9a-fA-F]{6})`, 'g'))].map(m => m[1]).at(-1)!

describe('theme contrast', () => {
  const light = read('styles.css')
  const dark = read('dark.css')
  it('light muted text meets 4.5:1 on page and surface', () => {
    const muted = token(light, '--muted')
    expect(ratio(muted, token(light, '--bg'))).toBeGreaterThanOrEqual(4.5)
    expect(ratio(muted, '#f9fbfd')).toBeGreaterThanOrEqual(4.5)
  })
  it('dark tokens meet 4.5:1 and are asserted last', () => {
    for (const name of ['--text', '--muted']) expect(ratio(token(dark, name), token(dark, '--surface-2'))).toBeGreaterThanOrEqual(4.5)
    expect(dark).toContain('[data-theme="dark"]{')
  })
})
