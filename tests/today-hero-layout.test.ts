import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('today hero layout', () => {
  const css = readFileSync('src/styles.css', 'utf8')

  it('keeps a minimum width for the summary column so long action labels cannot squeeze it to a vertical strip', () => {
    expect(css).toContain('grid-template-columns:minmax(280px,1fr) minmax(0,max-content)')
  })

  it('lets the action buttons wrap', () => {
    expect(css).toContain('.today-hero-actions{flex-wrap:wrap}')
  })
})
