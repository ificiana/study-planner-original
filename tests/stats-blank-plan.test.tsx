// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { buildBlankState } from '../src/lib/seed'
import { I18nProvider } from '../src/lib/i18n'

vi.mock('../src/AppContext', () => ({
  useApp: () => ({ state: buildBlankState(), actions: {}, dispatch: () => undefined }),
}))

import { StatsPage } from '../src/components/StatsPage'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
})

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })

afterEach(cleanup)

describe('StatsPage on a blank plan', () => {
  it.each(['zh', 'en'] as const)('renders without throwing in %s', language => {
    expect(() => render(<I18nProvider language={language}><StatsPage onOpenReplan={() => undefined} /></I18nProvider>)).not.toThrow()
  })
})
