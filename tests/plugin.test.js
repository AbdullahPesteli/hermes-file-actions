// Logic tests for desktop/plugin.js. The SDK and React are stubbed: the plugin only imports
// from '@hermes/plugin-sdk' and 'react*', which the host maps at runtime.
import { mock, test, expect } from 'bun:test'

mock.module('@hermes/plugin-sdk', () => ({ TRANSCRIPT_DIRECTIVE_AREA: 'transcript.directive', useI18n: () => ({ locale: 'en' }) }))
mock.module('react/jsx-runtime', () => ({ jsx: (t, p) => ({ t, p }), jsxs: (t, p) => ({ t, p }) }))
mock.module('react', () => ({ useState: (v) => [v, () => {}], useCallback: (f) => f, useRef: (v) => ({ current: v }), useEffect: () => {} }))

const mod = await import('../desktop/plugin.js')
const plugin = mod.default

test('default export registers both directive names', () => {
  const regs = []
  plugin.register({ register: (r) => regs.push(r) })
  expect(plugin.id).toBe('file-actions')
  expect(regs.map((r) => r.data.name).sort()).toEqual(['file-actions', 'finder-reveal'])
  const render = regs[0].data.render
  expect(render({ attrs: { path: 'not-a-path' } })).toBeNull()
  expect(render({ attrs: { path: '/tmp/x.txt' } })).not.toBeNull()
})

test('normalizePath handles quotes, file:// and percent-encoding', () => {
  expect(mod.normalizePath('"/a b/c.txt"')).toBe('/a b/c.txt')
  expect(mod.normalizePath('file:///Users/x/My%20File.md')).toBe('/Users/x/My File.md')
  expect(mod.normalizePath('/a%2Fb')).toBe('/a/b')
  expect(mod.normalizePath(null)).toBe('')
})

test('extOf', () => {
  expect(mod.extOf('/a/b.TXT')).toBe('txt')
  expect(mod.extOf('/a/.env')).toBe('')
  expect(mod.extOf('/a/folder')).toBe('')
})

test('pickLang: app locale first, then system, then English', () => {
  expect(mod.pickLang('tr', [])).toBe('tr')
  expect(mod.pickLang('en', ['tr-TR', 'en'])).toBe('tr')
  expect(mod.pickLang('de', ['de-DE'])).toBe('en')
  expect(mod.pickLang(undefined, ['fr'])).toBe('en')
})

const t = mod.makeT('en')
const ctxWith = (native, rest) => {
  const calls = []
  return {
    calls,
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); return () => clearTimeout(h) },
    os: { revealPath: async () => native },
    rest: async (path, opts) => { calls.push([path, opts]); return rest(path, opts) },
  }
}

test('reveal: native door succeeds, backend never called', async () => {
  const ctx = ctxWith(true, async () => { throw new Error('should not run') })
  expect(await mod.doReveal(ctx, t, '/x')).toBe(true)
  expect(ctx.calls.length).toBe(0)
})

test('reveal: no native door (Webapp) falls back to backend route', async () => {
  const ctx = ctxWith(false, async () => ({ ok: true }))
  expect(await mod.doReveal(ctx, t, '/x')).toBe(true)
  expect(ctx.calls[0][0]).toBe('/reveal')
  expect(ctx.calls[0][1].body).toEqual({ path: '/x' })
})

test('reveal: backend 404 file_not_found -> "not found"; other 404 -> backend missing', async () => {
  const missing = ctxWith(false, async () => { throw new Error('404: {"detail":"file_not_found"}') })
  await expect(mod.doReveal(missing, t, '/x')).rejects.toThrow('File not found on this computer')
  const unmounted = ctxWith(false, async () => { throw new Error('404: {"detail":"Not Found"}') })
  await expect(mod.doReveal(unmounted, t, '/x')).rejects.toThrow(/Backend route missing/)
})
