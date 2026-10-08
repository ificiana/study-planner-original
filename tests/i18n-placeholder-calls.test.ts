import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  if (statSync(path).isDirectory()) return name === 'dicts' ? [] : walk(path)
  return /\.tsx?$/.test(name) ? [path] : []
})

const placeholderKeys = new Set<string>()
for (const file of readdirSync('src/lib/i18n/dicts')) {
  const text = readFileSync(join('src/lib/i18n/dicts', file), 'utf8')
  for (const m of text.matchAll(/^\s*['"]([\w.]+)['"]:\s*(['"`])(.*)\2,?\s*$/gm)) if (m[3].includes('{{')) placeholderKeys.add(m[1])
}

describe('i18n placeholder calls', () => {
  it('never calls a {{var}} key without passing variables', () => {
    const offenders: string[] = []
    for (const file of walk('src')) {
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(/\b(?:t|tr)\(\s*'([\w.]+)'\s*\)/g)) if (placeholderKeys.has(m[1])) offenders.push(`${file}: ${m[1]}`)
    }
    expect(offenders).toEqual([])
  })
})
