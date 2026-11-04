import { TRANSCRIPT_DIRECTIVE_AREA, useI18n } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useCallback, useRef, useEffect } from 'react'

// file-actions — a small action island under every local file the agent delivers.
//
//   ::file-actions{path="/absolute/path" label="optional name"}
//
// Four chips: Show in Finder · Preview · Copy path · Copy text. The legacy directive
// name ::finder-reveal renders the same island so older transcripts keep working.
//
// Contract: every bridge call is timeout-wrapped and the chip reports the REAL result.
// No action ever claims success it did not get, and no action sends a chat turn.

const PLUGIN_ID = 'file-actions'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic'])
const TEXT_EXT = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'csv', 'tsv', 'log', 'py', 'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss', 'xml', 'ini', 'toml', 'cfg', 'conf', 'sh', 'bash', 'zsh', 'env', 'sql', 'swift', 'c', 'cpp', 'h', 'java', 'rs', 'go', 'rb', 'php', 'vue', 'svelte', 'graphql', 'plist', 'srt', 'vtt'])
const PREVIEW_MAX = 200000

// ── strings ────────────────────────────────────────────────────────────────
// English is the fallback. Add a language by adding a block here (PRs welcome).
const STRINGS = {
  en: {
    revealMac: 'Show in Finder',
    revealWin: 'Show in Explorer',
    revealOther: 'Show in folder',
    preview: 'Preview',
    closePreview: 'Close preview',
    copyPath: 'Copy path',
    copyText: 'Copy text',
    file: 'file',
    revealed: 'Shown in file manager',
    pathCopied: 'Path copied',
    textCopied: (n) => `Text copied (${n} characters)`,
    previewReady: 'Preview ready',
    openedDefault: 'Opened in the default app',
    notFound: 'File not found on this computer',
    revealTimeout: 'File manager did not respond (timeout)',
    serverTimeout: 'Server did not respond (timeout)',
    serverFailed: (m) => `Server action failed: ${m}`,
    noBridge: 'This window has no file bridge',
    noBackend: 'Backend route missing — is the file-actions agent plugin enabled?',
    clipboardFailed: 'Could not write to the clipboard',
    clipboardTimeout: 'Clipboard write timed out',
    readFailed: 'Could not read the file',
    readTimeout: 'Reading the file timed out',
    notText: 'Not a text file (binary content)',
    tooLarge: 'File too large to copy as text',
    imageTimeout: 'Reading the image timed out',
    openTimeout: 'Opening the file timed out',
    noBrowserPreview: 'This file type cannot be previewed in the browser — use Show in folder',
    previewTruncated: '… (preview truncated)',
  },
  tr: {
    revealMac: 'Finder’da Göster',
    revealWin: 'Gezgin’de Göster',
    revealOther: 'Klasörde Göster',
    preview: 'Önizle',
    closePreview: 'Önizlemeyi Kapat',
    copyPath: 'Yolu Kopyala',
    copyText: 'Metni Kopyala',
    file: 'dosya',
    revealed: 'Finder’da gösterildi',
    pathCopied: 'Yol kopyalandı',
    textCopied: (n) => `Metin kopyalandı (${n} karakter)`,
    previewReady: 'Önizleme hazır',
    openedDefault: 'Varsayılan uygulamada açıldı',
    notFound: 'Dosya bu bilgisayarda bulunamadı',
    revealTimeout: 'Finder yanıt vermedi (zaman aşımı)',
    serverTimeout: 'Sunucu yanıt vermedi (zaman aşımı)',
    serverFailed: (m) => `Sunucu işlemi başarısız: ${m}`,
    noBridge: 'Bu pencerede dosya köprüsü yok',
    noBackend: 'Sunucu tarafı yok — file-actions agent eklentisi açık mı?',
    clipboardFailed: 'Panoya yazılamadı',
    clipboardTimeout: 'Pano yazma zaman aşımına uğradı',
    readFailed: 'Dosya okunamadı',
    readTimeout: 'Dosya okuma zaman aşımına uğradı',
    notText: 'Bu dosya metin değil (ikili içerik)',
    tooLarge: 'Dosya metin olarak kopyalanamayacak kadar büyük',
    imageTimeout: 'Görsel okuma zaman aşımına uğradı',
    openTimeout: 'Dosya açma zaman aşımına uğradı',
    noBrowserPreview: 'Bu dosya türü tarayıcıda önizlenemiyor — Finder’da Göster’i kullan',
    previewTruncated: '… (önizleme kısaltıldı)',
  },
}

// The app locale wins when we have strings for it; otherwise the OS/browser language
// (the app ships no Turkish bundle, so a Turkish system would otherwise get English).
export function pickLang(appLocale, systemLangs) {
  const base = (c) => String(c || '').toLowerCase().split(/[-_]/)[0]
  const app = base(appLocale)
  if (app && app !== 'en' && STRINGS[app]) return app
  const sys = systemLangs || (typeof navigator !== 'undefined' ? (navigator.languages || [navigator.language]) : [])
  for (const c of sys) if (STRINGS[base(c)]) return base(c)
  return 'en'
}

export function makeT(lang) {
  const table = STRINGS[lang] || STRINGS.en
  return (key, ...args) => {
    const v = key in table ? table[key] : STRINGS.en[key]
    return typeof v === 'function' ? v(...args) : (v ?? key)
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
export function normalizePath(raw) {
  if (typeof raw !== 'string') return ''
  let p = raw.trim()
  if (!p) return ''
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1).trim()
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(new URL(p).pathname) } catch { p = p.replace(/^file:\/\//i, '') }
  } else {
    try { p = decodeURIComponent(p) } catch { /* keep raw */ }
  }
  return p
}

export function extOf(p) {
  const name = p.slice(p.lastIndexOf('/') + 1)
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

function displayName(p) {
  const trimmed = p.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || p
}

function hostOs() {
  const s = typeof navigator !== 'undefined' ? `${navigator.platform || ''} ${navigator.userAgent || ''}` : ''
  if (/Mac|iPhone|iPad/i.test(s)) return 'mac'
  if (/Win/i.test(s)) return 'win'
  return 'other'
}

function bridge() {
  return typeof window !== 'undefined' ? window.hermesDesktop : null
}

// Electron exposes revealPath; the browser-hosted Webapp does not, so it goes through
// this package's backend route instead (dashboard/plugin_api.py, runs on the serving machine).
function hasNativeReveal() {
  const b = bridge()
  return !!(b && typeof b.revealPath === 'function')
}

function withTimeout(ctx, promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false
    const cancel = ctx && ctx.setTimeout ? ctx.setTimeout(() => {
      if (!done) { done = true; reject(new Error(label)) }
    }, ms) : null
    Promise.resolve(promise).then(
      (v) => { if (!done) { done = true; try { cancel && cancel() } catch {} ; resolve(v) } },
      (e) => { if (!done) { done = true; try { cancel && cancel() } catch {} ; reject(e) } }
    )
  })
}

function readTextResult(raw) {
  if (typeof raw === 'string') return { text: raw, truncated: false }
  if (raw && typeof raw.text === 'string') return { text: raw.text, truncated: !!raw.truncated }
  return null
}

function toFileUrl(p) {
  return 'file://' + p.split('/').map((seg) => encodeURIComponent(seg)).join('/')
}

// ── actions ────────────────────────────────────────────────────────────────
// Reveal: the native door first (Electron's ctx.os.revealPath). The browser-hosted Webapp has
// no native door (it answers false), so fall back to this package's backend route through
// ctx.rest — the OS action then runs on the machine serving the page, where the files live.
async function backendReveal(ctx, t, p) {
  let res
  try {
    res = await withTimeout(ctx, ctx.rest('/reveal', { method: 'POST', body: { path: p }, timeoutMs: 10000 }), 12000, t('serverTimeout'))
  } catch (e) {
    const msg = String((e && e.message) || e || '')
    // The route answers 404 {"detail":"file_not_found"} for a missing file; any other 404
    // means the route itself is not mounted (agent plugin disabled / not installed).
    if (msg.indexOf('file_not_found') !== -1 || /"detail":"not found"/i.test(msg)) throw new Error(t('notFound'))
    if (/^404\b/.test(msg)) throw new Error(t('noBackend'))
    if (msg === t('serverTimeout')) throw e
    throw new Error(t('serverFailed', msg.slice(0, 160)))
  }
  if (!(res && res.ok)) throw new Error(t('notFound'))
  return true
}

export async function doReveal(ctx, t, p) {
  let ok = false
  try {
    ok = await withTimeout(ctx, ctx.os.revealPath(p), 8000, t('revealTimeout'))
  } catch (e) {
    if (String((e && e.message) || e) === t('revealTimeout')) throw e
  }
  if (ok === true) return true
  return backendReveal(ctx, t, p)
}

async function writeClip(ctx, t, text) {
  const ok = await withTimeout(ctx, ctx.os.writeClipboard(text), 6000, t('clipboardTimeout'))
  if (ok === false || ok === null) throw new Error(t('clipboardFailed'))
}

async function readText(ctx, t, p) {
  const b = bridge()
  if (!b || !b.readFileText) throw new Error(t('noBridge'))
  const got = readTextResult(await withTimeout(ctx, b.readFileText(p), 8000, t('readTimeout')))
  if (!got) throw new Error(t('readFailed'))
  return got
}

async function doCopyText(ctx, t, p) {
  const got = await readText(ctx, t, p)
  if (got.text.indexOf('\u0000') !== -1) throw new Error(t('notText'))
  if (got.truncated) throw new Error(t('tooLarge'))
  await writeClip(ctx, t, got.text)
  return got.text.length
}

async function doPreview(ctx, t, p, ext) {
  const b = bridge()
  if (IMAGE_EXT.has(ext) && b && b.readFileDataUrl) {
    const url = await withTimeout(ctx, b.readFileDataUrl(p), 10000, t('imageTimeout'))
    if (typeof url === 'string' && url.indexOf('data:') === 0) return { kind: 'image', url }
  }
  if (b && b.readFileText && (TEXT_EXT.has(ext) || !IMAGE_EXT.has(ext))) {
    try {
      const got = await readText(ctx, t, p)
      if (got.text.length > 0 && got.text.indexOf('\u0000') === -1) {
        const text = got.text.length > PREVIEW_MAX ? got.text.slice(0, PREVIEW_MAX) + '\n' + t('previewTruncated') : got.text
        return { kind: 'text', text }
      }
    } catch (e) {
      if (TEXT_EXT.has(ext)) throw e
    }
  }
  // A browser cannot open a file:// URL on the server's disk — say so instead of
  // reporting an "opened" that never happened.
  if (!hasNativeReveal()) throw new Error(t('noBrowserPreview'))
  await withTimeout(ctx, ctx.os.openExternal(toFileUrl(p)), 8000, t('openTimeout'))
  return { kind: 'opened' }
}

// ── UI ─────────────────────────────────────────────────────────────────────
function icon(paths, size) {
  return jsx('svg', {
    width: size || 13, height: size || 13, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { flex: '0 0 auto', opacity: 0.85 }, 'aria-hidden': true,
    children: paths,
  })
}

const FOLDER_ICON = jsx('path', { d: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6c.4 0 .8.2 1.1.5l.8.9h4.5A1.5 1.5 0 0 1 14 5.9v5.6A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z' })
const EYE_ICON = jsxs('g', { children: [jsx('path', { d: 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z' }), jsx('circle', { cx: 8, cy: 8, r: 2 })] })
const COPY_ICON = jsxs('g', { children: [jsx('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }), jsx('path', { d: 'M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5' })] })
const TEXT_ICON = jsxs('g', { children: [jsx('rect', { x: 3, y: 2, width: 10, height: 12, rx: 1.5 }), jsx('path', { d: 'M5.5 6h5M5.5 8.5h5M5.5 11h3' })] })
const FILE_ICON = jsxs('g', { children: [jsx('path', { d: 'M4 2.5h5l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z' }), jsx('path', { d: 'M9 2.5v3h3' })] })

const CSS = `
.fa-island { box-sizing: border-box; width: 100%; margin: 12px 0; padding: 12px 14px 11px; background: var(--ui-bg-card); border: 1px solid var(--ui-stroke-secondary); border-radius: 12px; }
.fa-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; color: var(--ui-text-secondary); }
.fa-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 600; color: var(--ui-text-primary); }
.fa-badge { flex: 0 0 auto; font-size: 10px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; color: var(--ui-text-tertiary); background: var(--ui-inline-code-background); border-radius: 5px; padding: 2px 7px; }
.fa-chips { display: flex; flex-wrap: wrap; gap: 7px; }
.fa-chip { display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; border-radius: 7px; border: 1px solid var(--ui-stroke-secondary); background: transparent; color: var(--ui-text-secondary); font-family: inherit; font-size: 12px; font-weight: 500; line-height: 16px; white-space: nowrap; cursor: pointer; transition: background 120ms ease, border-color 120ms ease, color 120ms ease; }
.fa-chip:hover:not(:disabled) { background: var(--ui-control-hover-background); border-color: var(--ui-stroke-tertiary); color: var(--ui-text-primary); }
.fa-chip:active:not(:disabled) { background: var(--ui-control-active-background); }
.fa-chip:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 1px; }
.fa-chip:disabled { opacity: 0.5; cursor: default; }
.fa-chip[aria-busy="true"] { opacity: 0.75; }
.fa-status { margin-top: 9px; font-size: 11.5px; line-height: 15px; color: var(--ui-text-tertiary); }
.fa-ok { color: var(--ui-success, var(--ui-green)); }
.fa-err { color: var(--ui-red); }
.fa-prev { margin-top: 10px; padding: 9px 11px; border: 1px solid var(--ui-stroke-secondary); border-radius: 8px; background: var(--ui-inline-code-background); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 16px; color: var(--ui-text-secondary); white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; }
.fa-img { margin-top: 10px; display: block; max-width: 100%; max-height: 300px; border: 1px solid var(--ui-stroke-secondary); border-radius: 8px; }
`

function FileActions({ path, label, ctx }) {
  const { locale } = useI18n() || {}
  const t = makeT(pickLang(locale))
  const [busy, setBusy] = useState(null)
  const [status, setStatus] = useState(null)
  const [preview, setPreview] = useState(null)
  const clearTimer = useRef(null)
  const mounted = useRef(true)

  useEffect(() => () => {
    mounted.current = false
    try { clearTimer.current && clearTimer.current() } catch {}
  }, [])

  const flash = useCallback((kind, text) => {
    if (!mounted.current) return
    setStatus({ kind, text })
    try { clearTimer.current && clearTimer.current() } catch {}
    if (ctx && ctx.setTimeout) {
      clearTimer.current = ctx.setTimeout(() => { if (mounted.current) setStatus(null) }, 5000)
    }
  }, [ctx])

  const run = useCallback(async (action) => {
    if (busy) return
    setBusy(action)
    try {
      if (action === 'reveal') {
        await doReveal(ctx, t, path)
        flash('ok', t('revealed'))
      } else if (action === 'copyPath') {
        await writeClip(ctx, t, path)
        flash('ok', t('pathCopied'))
      } else if (action === 'copyText') {
        flash('ok', t('textCopied', await doCopyText(ctx, t, path)))
      } else if (action === 'preview') {
        if (preview) { setPreview(null); return }
        const res = await doPreview(ctx, t, path, extOf(path))
        if (res.kind === 'opened') flash('ok', t('openedDefault'))
        else { if (mounted.current) setPreview(res); flash('ok', t('previewReady')) }
      }
    } catch (e) {
      flash('err', String((e && e.message) || e))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [busy, ctx, path, preview, flash, t])

  const os = hostOs()
  const revealLabel = os === 'mac' ? t('revealMac') : os === 'win' ? t('revealWin') : t('revealOther')

  const chip = (action, ic, text) => jsxs('button', {
    type: 'button',
    className: 'fa-chip',
    disabled: !!busy,
    'aria-busy': busy === action,
    title: text,
    onClick: () => run(action),
    children: [ic, text],
  }, action)

  return jsxs('div', {
    className: 'fa-island',
    children: [
      jsx('style', { children: CSS }),
      jsxs('div', {
        className: 'fa-head',
        children: [
          icon(FILE_ICON, 15),
          jsx('span', { className: 'fa-name', title: path, children: label || displayName(path) }),
          jsx('span', { className: 'fa-badge', children: extOf(path) || t('file') }),
        ],
      }),
      jsxs('div', {
        className: 'fa-chips',
        children: [
          chip('reveal', icon(FOLDER_ICON), revealLabel),
          chip('preview', icon(EYE_ICON), preview ? t('closePreview') : t('preview')),
          chip('copyPath', icon(COPY_ICON), t('copyPath')),
          chip('copyText', icon(TEXT_ICON), t('copyText')),
        ],
      }),
      status ? jsx('div', {
        className: 'fa-status ' + (status.kind === 'ok' ? 'fa-ok' : 'fa-err'),
        role: status.kind === 'ok' ? 'status' : 'alert',
        children: (status.kind === 'ok' ? '\u2713 ' : '\u2715 ') + status.text,
      }) : null,
      preview && preview.kind === 'image' ? jsx('img', { className: 'fa-img', src: preview.url, alt: '' }) : null,
      preview && preview.kind === 'text' ? jsx('pre', { className: 'fa-prev', children: preview.text }) : null,
    ],
  })
}

export default {
  id: PLUGIN_ID,
  name: 'File actions',
  description: 'Show in Finder / Preview / Copy path / Copy text under every delivered file.',
  register(ctx) {
    const render = ({ attrs }) => {
      const path = normalizePath(attrs && (attrs.path || attrs.file || attrs.src))
      if (!path || path.indexOf('/') === -1) return null
      return jsx(FileActions, { path, label: attrs && (attrs.label || attrs.name), ctx })
    }
    ctx.register({ id: 'directive', area: TRANSCRIPT_DIRECTIVE_AREA, data: { name: 'file-actions', render } })
    ctx.register({ id: 'directive-legacy', area: TRANSCRIPT_DIRECTIVE_AREA, data: { name: 'finder-reveal', render } })
  },
}
