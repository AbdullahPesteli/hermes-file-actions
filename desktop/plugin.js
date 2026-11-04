import { TRANSCRIPT_DIRECTIVE_AREA, useI18n } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useCallback, useRef, useEffect } from 'react'

// file-actions — "quiet rich" file cards under every local file the agent delivers.
//
//   ::file-actions{path="/absolute/path" label="optional name"}
//   ::file-actions{paths="/a.jpg|/b.jpg|/c.jpg"}        → one gallery card
//
// Up front: the file itself (live thumbnail + facts) and ONE primary action (Show in Finder).
// Everything else lives in the ⋯ menu: Preview, Open with ▸ (apps the OS lists for the file),
// Copy path, Copy text. A missing file says so before you click.
//
// Contract: every bridge call is timeout-wrapped and reports the REAL result. No action ever
// claims success it did not get, and no action sends a chat turn.

const PLUGIN_ID = 'file-actions'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg', 'opus', 'aiff', 'caf'])
const TEXT_EXT = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'csv', 'tsv', 'log', 'py', 'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss', 'xml', 'ini', 'toml', 'cfg', 'conf', 'sh', 'bash', 'zsh', 'env', 'sql', 'swift', 'c', 'cpp', 'h', 'java', 'rs', 'go', 'rb', 'php', 'vue', 'svelte', 'graphql', 'plist', 'srt', 'vtt'])
const PREVIEW_MAX = 200000

// ── strings ────────────────────────────────────────────────────────────────
// English is the fallback. Add a language by adding a block here (PRs welcome).
const STRINGS = {
  en: {
    revealMac: 'Show in Finder', revealWin: 'Show in Explorer', revealOther: 'Show in folder',
    revealAllMac: 'Show all in Finder', revealAllOther: 'Show all in folder',
    more: 'More actions', preview: 'Preview', closePreview: 'Close preview', openWith: 'Open with',
    openDefault: 'Open', copyPath: 'Copy path', copyPaths: (n) => `Copy ${n} paths`, copyText: 'Copy text',
    menuFile: 'File', noApps: 'No other apps', loading: 'Loading…',
    file: 'file', folder: 'Folder', items: (n) => `${n} items`, images: (n) => `${n} images`, files: (n) => `${n} files`,
    lines: (n) => `${n} lines`,
    kind: { image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF', folder: 'Folder', file: 'File' },
    missing: 'No longer here', missingHint: 'moved or deleted', defaultApp: 'default',
    revealed: 'Shown in file manager', revealedN: (n) => `${n} files selected in Finder`, pathCopied: 'Path copied',
    pathsCopied: (n) => `${n} paths copied`, textCopied: (n) => `Text copied (${n} characters)`, openedWith: (a) => `Opened in ${a}`,
    opened: 'Opened in the default app', notFound: 'File not found on this computer',
    revealTimeout: 'File manager did not respond (timeout)', serverTimeout: 'Server did not respond (timeout)',
    serverFailed: (m) => `Server action failed: ${m}`, noBridge: 'This window has no file bridge',
    noBackend: 'Backend route missing — is the file-actions agent plugin enabled?',
    clipboardFailed: 'Could not write to the clipboard', clipboardTimeout: 'Clipboard write timed out',
    readFailed: 'Could not read the file', readTimeout: 'Reading the file timed out', notText: 'Not a text file',
    tooLarge: 'File too large to copy as text', noPreview: 'No inline preview for this type — use Open with',
    previewTruncated: '… (preview truncated)', close: 'Close',
    player: 'Video player', play: 'Play', pause: 'Pause', frameBack: 'Previous frame (←)', frameFwd: 'Next frame (→)', speed: 'Speed', loop: 'Loop', mute: 'Mute (M)', fullscreen: 'Fullscreen (F)', keys: 'Shortcuts (?)',
    keysHelp: 'Click the player, then: Space play/pause · ← → one frame · Shift+← → one second · J back 1 s · K stop · L faster (×1, ×2, ×4) · 0–9 jump to 0–90 % · M mute · F fullscreen',
  },
  tr: {
    revealMac: 'Finder’da Göster', revealWin: 'Gezgin’de Göster', revealOther: 'Klasörde Göster',
    revealAllMac: 'Hepsini Finder’da seç', revealAllOther: 'Hepsini klasörde göster',
    more: 'Diğer işlemler', preview: 'Önizle', closePreview: 'Önizlemeyi kapat', openWith: 'Şununla aç',
    openDefault: 'Aç', copyPath: 'Yolu kopyala', copyPaths: (n) => `${n} yolu kopyala`, copyText: 'Metni kopyala',
    menuFile: 'Dosya', noApps: 'Başka uygulama yok', loading: 'Yükleniyor…',
    file: 'dosya', folder: 'Klasör', items: (n) => `${n} öğe`, images: (n) => `${n} görsel`, files: (n) => `${n} dosya`,
    lines: (n) => `${n} satır`,
    kind: { image: 'Görsel', video: 'Video', audio: 'Ses', pdf: 'PDF', folder: 'Klasör', file: 'Dosya' },
    missing: 'Artık burada değil', missingHint: 'taşınmış ya da silinmiş', defaultApp: 'varsayılan',
    revealed: 'Finder’da gösterildi', revealedN: (n) => `${n} dosya Finder’da seçildi`, pathCopied: 'Yol kopyalandı',
    pathsCopied: (n) => `${n} yol kopyalandı`, textCopied: (n) => `Metin kopyalandı (${n} karakter)`, openedWith: (a) => `${a} ile açıldı`,
    opened: 'Varsayılan uygulamada açıldı', notFound: 'Dosya bu bilgisayarda bulunamadı',
    revealTimeout: 'Finder yanıt vermedi (zaman aşımı)', serverTimeout: 'Sunucu yanıt vermedi (zaman aşımı)',
    serverFailed: (m) => `Sunucu işlemi başarısız: ${m}`, noBridge: 'Bu pencerede dosya köprüsü yok',
    noBackend: 'Sunucu tarafı yok — file-actions agent eklentisi açık mı?',
    clipboardFailed: 'Panoya yazılamadı', clipboardTimeout: 'Pano yazma zaman aşımına uğradı',
    readFailed: 'Dosya okunamadı', readTimeout: 'Dosya okuma zaman aşımına uğradı', notText: 'Bu dosya metin değil',
    tooLarge: 'Dosya metin olarak kopyalanamayacak kadar büyük', noPreview: 'Bu tür için satır içi önizleme yok — Şununla aç’ı kullan',
    previewTruncated: '… (önizleme kısaltıldı)', close: 'Kapat',
    player: 'Video oynatıcı', play: 'Oynat', pause: 'Duraklat', frameBack: 'Önceki kare (←)', frameFwd: 'Sonraki kare (→)', speed: 'Hız', loop: 'Döngü', mute: 'Sessiz (M)', fullscreen: 'Tam ekran (F)', keys: 'Kısayollar (?)',
    keysHelp: 'Oynatıcıya bir kez tıkla, sonra: Boşluk oynat/duraklat · ← → bir kare · Shift+← → bir saniye · J 1 sn geri · K dur · L hızlandır (×1, ×2, ×4) · 0–9 %0–90’a atla · M sessiz · F tam ekran',
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

export function kindOf(p) {
  const e = extOf(p)
  if (IMAGE_EXT.has(e)) return 'image'
  if (VIDEO_EXT.has(e)) return 'video'
  if (AUDIO_EXT.has(e)) return 'audio'
  if (e === 'pdf') return 'pdf'
  return 'file'
}

function displayName(p) {
  const trimmed = p.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || p
}

export function formatBytes(n) {
  if (n == null || !isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

export function formatDuration(s) {
  if (s == null || !isFinite(s)) return ''
  const t = Math.round(s)
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export function metaLine(info, t) {
  if (!info) return ''
  if (info.kind === 'folder') return [t('folder'), info.items != null ? t('items', info.items) : ''].filter(Boolean).join(' · ')
  const parts = [(info.ext || t('file')).toUpperCase()]
  if (info.duration) parts.push(formatDuration(info.duration))
  if (info.width && info.height) parts.push(`${info.width}×${info.height}`)
  if (info.lines) parts.push(t('lines', info.lines))
  if (info.size != null) parts.push(formatBytes(info.size))
  return parts.join(' · ')
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

const qs = (path) => '?path=' + encodeURIComponent(path)

// ── backend calls (cached per path for the session) ─────────────────────────
const infoCache = new Map()
const thumbCache = new Map()
const appsCache = new Map()

function cached(map, key, load) {
  if (!map.has(key)) map.set(key, load().catch((e) => { map.delete(key); throw e }))
  return map.get(key)
}

function backendError(t, e) {
  const msg = String((e && e.message) || e || '')
  if (msg.indexOf('file_not_found') !== -1) return new Error(t('notFound'))
  if (/^404\b/.test(msg)) return new Error(t('noBackend'))
  if (msg === t('serverTimeout')) return e
  return new Error(t('serverFailed', msg.slice(0, 160)))
}

async function post(ctx, t, route, body) {
  let res
  try {
    res = await withTimeout(ctx, ctx.rest(route, { method: 'POST', body, timeoutMs: 10000 }), 12000, t('serverTimeout'))
  } catch (e) { throw backendError(t, e) }
  if (!(res && res.ok)) throw new Error(t('notFound'))
  return res
}

export const loadInfo = (ctx, p) => cached(infoCache, p, () => withTimeout(ctx, ctx.rest('/info' + qs(p), { timeoutMs: 8000 }), 9000, 'info'))
const loadThumb = (ctx, p) => cached(thumbCache, p, () => withTimeout(ctx, ctx.rest('/thumb' + qs(p), { timeoutMs: 15000 }), 16000, 'thumb').then((r) => r && r.dataUrl))
const loadApps = (ctx, p) => cached(appsCache, p, () => withTimeout(ctx, ctx.rest('/apps' + qs(p), { timeoutMs: 8000 }), 9000, 'apps').then((r) => (r && r.apps) || []))

// ── actions ────────────────────────────────────────────────────────────────
// Reveal: the native door first (Electron's ctx.os.revealPath). The browser-hosted Webapp has
// no native door (it answers false), so fall back to this package's backend route.
export async function doReveal(ctx, t, p) {
  let ok = false
  try {
    ok = await withTimeout(ctx, ctx.os.revealPath(p), 8000, t('revealTimeout'))
  } catch (e) {
    if (String((e && e.message) || e) === t('revealTimeout')) throw e
  }
  if (ok === true) return true
  await post(ctx, t, '/reveal', { path: p })
  return true
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

// A URL this window can stream (Range-aware, seekable) for audio/video. Electron streams local
// files through its media protocol; the Webapp gets a ticketed /api/files/stream URL.
// Same order as the app's own player (src/lib/media.ts resolveMediaPlaybackSrc): the bridge's
// authenticated stream URL when it offers one, else Electron's local Range-aware media protocol.
async function streamUrl(ctx, p) {
  const b = bridge()
  if (b && typeof b.getGatewayFileStreamUrl === 'function') {
    try { const u = await withTimeout(ctx, b.getGatewayFileStreamUrl({ path: p }), 8000, 'stream'); if (u) return u } catch {}
  }
  if (b && hasNativeReveal()) return 'hermes-media://stream/' + encodeURIComponent(p)
  return null
}

async function loadPreview(ctx, t, p, kind) {
  if (kind === 'video' || kind === 'audio') {
    const src = await streamUrl(ctx, p)
    if (src) return { kind, src, poster: kind === 'video' ? await loadThumb(ctx, p).catch(() => null) : null }
  }
  if (kind === 'image' || kind === 'video' || kind === 'pdf') {
    const url = await loadThumb(ctx, p).catch(() => null)
    const b = bridge()
    if (kind === 'image' && b && b.readFileDataUrl) {
      const full = await withTimeout(ctx, b.readFileDataUrl(p), 10000, t('readTimeout')).catch(() => null)
      if (typeof full === 'string' && full.indexOf('data:') === 0) return { kind: 'image', url: full }
    }
    if (url) return { kind: 'image', url }
    throw new Error(t('noPreview'))
  }
  if (TEXT_EXT.has(extOf(p)) || kind === 'file') {
    const got = await readText(ctx, t, p)
    if (got.text.indexOf('\u0000') !== -1) throw new Error(t('noPreview'))
    const text = got.text.length > PREVIEW_MAX ? got.text.slice(0, PREVIEW_MAX) + '\n' + t('previewTruncated') : got.text
    return { kind: 'text', text }
  }
  throw new Error(t('noPreview'))
}

// ── UI bits ────────────────────────────────────────────────────────────────
const P = {
  folder: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6c.4 0 .8.2 1.1.5l.8.9h4.5A1.5 1.5 0 0 1 14 5.9v5.6A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z',
  file: 'M4 2.5h5l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1zM9 2.5v3h3',
  copy: 'M5.5 7a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 13.5 7v5a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 12zM10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5',
  text: 'M4.5 2h7A1.5 1.5 0 0 1 13 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12.5v-9A1.5 1.5 0 0 1 4.5 2zM5.5 6h5M5.5 8.5h5M5.5 11h3',
  eye: 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  apps: 'M3.5 2.5h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1zM9.5 2.5h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1zM3.5 8.5h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1zM9.5 8.5h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z',
  right: 'M6 4l4 4-4 4',
  x: 'M4 4l8 8M12 4l-8 8',
  check: 'M3.5 8.5l3 3 6-7',
  music: 'M6 12.5V3.5l7-1.5v9M6 12.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM13 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
}

function Icon({ d, size = 14, fill }) {
  return jsx('svg', {
    className: 'fa-ico', width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true,
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: jsx('path', { d, fill: fill || 'none' }),
  })
}

function Dots() {
  return jsxs('svg', { className: 'fa-ico', width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'currentColor', children: [
    jsx('circle', { cx: 3.5, cy: 8, r: 1.15 }), jsx('circle', { cx: 8, cy: 8, r: 1.15 }), jsx('circle', { cx: 12.5, cy: 8, r: 1.15 }),
  ] })
}

// A type glyph for files with no picture: icon + extension, so the card never shows an empty box.
function Glyph({ kind, ext, missing }) {
  const d = kind === 'audio' ? P.music : kind === 'folder' ? P.folder : P.file
  return jsxs('span', { className: 'fa-glyph', children: [jsx(Icon, { d, size: 16 }), !missing && ext && kind !== 'folder' ? jsx('b', { children: ext.slice(0, 4) }) : null] })
}

const CSS = `
.fa-glyph{display:flex;flex-direction:column;align-items:center;gap:2px;color:var(--ui-text-tertiary)}
.fa-glyph b{font-size:9px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;line-height:10px}
.fa-ico{flex:0 0 auto}
.fa-card{position:relative;display:flex;align-items:center;gap:12px;box-sizing:border-box;width:100%;min-height:66px;margin:10px 0;padding:8px;border:1px solid var(--ui-stroke-secondary);border-radius:12px;background:var(--ui-bg-card);transition:border-color 140ms ease}
.fa-card:hover{border-color:var(--ui-stroke-tertiary)}
.fa-card.fa-missing{border-style:dashed;border-color:var(--ui-stroke-tertiary);background:transparent}
.fa-thumb{position:relative;flex:0 0 auto;width:64px;height:48px;border-radius:8px;overflow:hidden;background:var(--ui-inline-code-background);display:grid;place-items:center;color:var(--ui-text-tertiary);border:0;padding:0;cursor:pointer}
.fa-thumb img{width:100%;height:100%;object-fit:cover;display:block;opacity:0;transition:opacity 180ms ease-out}
.fa-thumb img.fa-in{opacity:1}
.fa-missing .fa-thumb{background:transparent;border:1px dashed var(--ui-stroke-secondary);cursor:default}
.fa-dur{position:absolute;right:3px;bottom:3px;padding:1px 4px;border-radius:4px;background:rgba(0,0,0,.62);color:#fff;font-size:10px;font-weight:600;line-height:13px;font-variant-numeric:tabular-nums}
.fa-play{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.fa-play i{width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.42);display:grid;place-items:center}
.fa-play i:after{content:"";margin-left:2px;border-left:6px solid #fff;border-top:4px solid transparent;border-bottom:4px solid transparent}
.fa-meta{flex:1 1 auto;min-width:0}
.fa-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.8px;font-weight:600;color:var(--ui-text-primary)}
.fa-sub{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.2px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums}
.fa-missing .fa-name{color:var(--ui-text-secondary);font-weight:500}
.fa-acts{position:relative;display:flex;align-items:center;gap:2px;flex:0 0 auto}
.fa-pri{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;border:1px solid var(--ui-stroke-secondary);background:transparent;color:var(--ui-text-secondary);font:inherit;font-size:12px;font-weight:500;line-height:16px;white-space:nowrap;cursor:pointer;transition:background 120ms ease,color 120ms ease,border-color 120ms ease}
.fa-pri:hover:not(:disabled){background:var(--ui-control-hover-background);color:var(--ui-text-primary);border-color:var(--ui-stroke-tertiary)}
.fa-ib{width:30px;height:30px;border-radius:8px;border:0;background:transparent;color:var(--ui-text-tertiary);display:grid;place-items:center;cursor:pointer;transition:background 120ms ease,color 120ms ease,opacity 140ms ease}
.fa-ib:hover,.fa-ib[aria-expanded="true"]{background:var(--ui-control-hover-background);color:var(--ui-text-primary)}
.fa-ib.fa-quiet{opacity:0}
.fa-ib.fa-done{color:var(--ui-success,var(--ui-green))}
.fa-card:hover .fa-ib.fa-quiet,.fa-card:focus-within .fa-ib.fa-quiet,.fa-ib.fa-quiet[aria-pressed="true"]{opacity:1}
.fa-pri:active:not(:disabled),.fa-ib:active{transform:scale(.97)}
.fa-pri:focus-visible,.fa-ib:focus-visible,.fa-thumb:focus-visible,.fa-mi:focus-visible{outline:2px solid var(--ui-accent);outline-offset:1px}
.fa-pri:disabled{opacity:.55;cursor:default}
.fa-menu{position:absolute;z-index:30;top:calc(100% + 6px);right:0;min-width:210px;padding:5px;border-radius:10px;background:var(--ui-bg-card);border:1px solid var(--ui-stroke-secondary);box-shadow:0 10px 30px rgba(0,0,0,.32),0 2px 6px rgba(0,0,0,.18);transform-origin:top right;animation:fa-in 150ms cubic-bezier(.23,1,.32,1)}
.fa-menu.fa-sub{top:-6px;right:calc(100% + 4px)}
.fa-menu.fa-sub.fa-r{right:auto;left:calc(100% + 4px);transform-origin:top left}
@keyframes fa-in{from{opacity:0;transform:scale(.97) translateY(-2px)}to{opacity:1;transform:none}}
.fa-mh{padding:5px 9px 3px;font-size:10.5px;letter-spacing:.3px;text-transform:uppercase;color:var(--ui-text-tertiary)}
.fa-mi{position:relative;display:flex;align-items:center;gap:9px;width:100%;padding:6px 9px;border:0;border-radius:6px;background:transparent;color:var(--ui-text-primary);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
.fa-mi:hover:not(:disabled),.fa-mi[aria-expanded="true"]{background:var(--ui-control-hover-background)}
.fa-mi:disabled{opacity:.42;cursor:default}
.fa-mi .fa-ico{opacity:.75}
.fa-mi .fa-k{margin-left:auto;padding-left:12px;font-size:11px;color:var(--ui-text-tertiary)}
.fa-mi .fa-chev{margin-left:auto;opacity:.55}
.fa-sep{height:1px;margin:4px 2px;background:var(--ui-stroke-secondary)}
.fa-appdot{width:14px;height:14px;border-radius:4px;flex:0 0 auto;background:var(--ui-inline-code-background)}
.fa-status{margin:-4px 0 8px 2px;font-size:11.5px;line-height:15px}
.fa-ok{color:var(--ui-success,var(--ui-green))}
.fa-err{color:var(--ui-red)}
.fa-exp{display:grid;grid-template-rows:0fr;transition:grid-template-rows 220ms cubic-bezier(.23,1,.32,1)}
.fa-exp.fa-on{grid-template-rows:1fr}
.fa-exp>div{overflow:hidden;min-height:0}
.fa-prev{margin:-2px 0 10px;padding:10px 12px;border:1px solid var(--ui-stroke-secondary);border-radius:10px;background:var(--ui-inline-code-background);font:11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ui-text-secondary);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto}
.fa-card.fa-video .fa-thumb{width:96px;height:54px}
.fa-player{display:block;box-sizing:border-box;width:100%;aspect-ratio:16/9;max-height:420px;margin:-2px 0 10px;border-radius:10px;background:#000;border:1px solid var(--ui-stroke-secondary)}
.fa-audio{display:block;width:100%;margin:-2px 0 10px}
.fa-pl{position:relative;margin:-2px 0 10px;border-radius:10px;overflow:hidden;background:#000;border:1px solid var(--ui-stroke-secondary);outline:none}
.fa-pl:focus-visible{box-shadow:0 0 0 2px var(--ui-accent)}
.fa-pv{display:block;width:100%;aspect-ratio:16/9;max-height:460px;object-fit:contain;background:#000;cursor:pointer}
.fa-pc{padding:6px 10px 8px;background:var(--ui-bg-card);border-top:1px solid var(--ui-stroke-secondary)}
.fa-bar{position:relative;height:18px;cursor:pointer;touch-action:none;display:flex;align-items:center}
.fa-bar-bg{position:relative;width:100%;height:4px;border-radius:2px;background:var(--ui-stroke-secondary);overflow:hidden;transition:height 120ms ease}
.fa-bar:hover .fa-bar-bg{height:6px}
.fa-bar-fill{height:100%;background:var(--ui-accent)}
.fa-bar-knob{position:absolute;top:50%;width:11px;height:11px;margin:-5.5px 0 0 -5.5px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.5);pointer-events:none;transform:scale(0);transition:transform 120ms ease}
.fa-bar:hover .fa-bar-knob,.fa-pl:focus-within .fa-bar-knob{transform:scale(1)}
.fa-tip{position:absolute;bottom:22px;display:flex;flex-direction:column;align-items:center;gap:3px;pointer-events:none;z-index:3}
.fa-tipimg{width:100%;border-radius:6px;background-repeat:no-repeat;box-shadow:0 6px 18px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.18)}
.fa-tip span{padding:1px 6px;border-radius:4px;background:rgba(0,0,0,.8);color:#fff;font-size:10.5px;font-variant-numeric:tabular-nums}
.fa-row{display:flex;align-items:center;gap:2px;margin-top:2px}
.fa-pb{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:var(--ui-text-secondary);display:grid;place-items:center;cursor:pointer;transition:background 120ms ease,color 120ms ease}
.fa-pb:hover{background:var(--ui-control-hover-background);color:var(--ui-text-primary)}
.fa-pb:active{transform:scale(.95)}
.fa-pb.fa-on{color:var(--ui-accent)}
.fa-pb-main{color:var(--ui-text-primary)}
.fa-tc{margin-left:6px;font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums}
.fa-sp{flex:1}
.fa-speeds{display:flex;gap:1px;margin-right:4px;padding:2px;border-radius:7px;background:var(--ui-inline-code-background)}
.fa-sb{border:0;background:transparent;color:var(--ui-text-tertiary);font:inherit;font-size:11px;font-variant-numeric:tabular-nums;padding:3px 6px;border-radius:5px;cursor:pointer}
.fa-sb:hover{color:var(--ui-text-primary)}
.fa-sb.fa-on{background:var(--ui-bg-card);color:var(--ui-text-primary);box-shadow:0 0 0 1px var(--ui-stroke-secondary)}
.fa-q{font-size:12px;font-weight:600}
.fa-keys{margin-top:6px;font-size:11px;line-height:1.6;color:var(--ui-text-tertiary)}

.fa-prev-img{display:block;max-width:100%;max-height:360px;margin:-2px 0 10px;border-radius:10px;border:1px solid var(--ui-stroke-secondary)}
.fa-gal{box-sizing:border-box;width:100%;margin:10px 0;padding:8px;border:1px solid var(--ui-stroke-secondary);border-radius:12px;background:var(--ui-bg-card)}
.fa-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px}
.fa-tile{position:relative;aspect-ratio:4/3;border-radius:8px;overflow:hidden;background:var(--ui-inline-code-background);border:0;padding:0;cursor:zoom-in;transition:transform 160ms cubic-bezier(.23,1,.32,1)}
.fa-tile:hover{transform:scale(1.015)}
.fa-tile img{width:100%;height:100%;object-fit:cover;display:block;opacity:0;transition:opacity 180ms ease-out}
.fa-tile img.fa-in{opacity:1}
.fa-tile.fa-gone{cursor:default;border:1px dashed var(--ui-stroke-secondary);background:transparent}
.fa-gft{position:relative;display:flex;align-items:center;gap:8px;padding:8px 2px 0}
.fa-gft .fa-sub{flex:1}
.fa-lb{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:rgba(0,0,0,.78);animation:fa-fade 160ms ease-out;cursor:zoom-out}
.fa-lb img{max-width:92vw;max-height:88vh;border-radius:10px;animation:fa-in 200ms cubic-bezier(.23,1,.32,1);box-shadow:0 20px 60px rgba(0,0,0,.5)}
.fa-lb .fa-cap{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);padding:5px 12px;border-radius:999px;background:rgba(20,20,20,.8);color:#ddd;font-size:12px}
@keyframes fa-fade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.fa-menu,.fa-lb,.fa-lb img{animation:none}.fa-exp,.fa-thumb img,.fa-tile img{transition:none}.fa-tile:hover{transform:none}}
`

function Style() { return jsx('style', { children: CSS }) }

function useT() {
  const { locale } = useI18n() || {}
  return makeT(pickLang(locale))
}

function useStatus(ctx) {
  const [status, setStatus] = useState(null)
  const timer = useRef(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false; try { timer.current && timer.current() } catch {} }, [])
  const flash = useCallback((kind, text) => {
    if (!alive.current) return
    setStatus({ kind, text })
    try { timer.current && timer.current() } catch {}
    if (ctx && ctx.setTimeout) timer.current = ctx.setTimeout(() => { if (alive.current) setStatus(null) }, 4500)
  }, [ctx])
  return [status, flash, alive]
}

function StatusLine({ status }) {
  if (!status) return null
  return jsx('div', {
    className: 'fa-status ' + (status.kind === 'ok' ? 'fa-ok' : 'fa-err'),
    role: status.kind === 'ok' ? 'status' : 'alert',
    children: (status.kind === 'ok' ? '✓ ' : '✕ ') + status.text,
  })
}

function useOutside(open, close, ref) {
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) close() }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true) }
  }, [open, close, ref])
}

function MenuItem({ icon, label, kbd, onClick, disabled, chevron, expanded, children, onEnter }) {
  return jsxs('button', {
    type: 'button', className: 'fa-mi', role: 'menuitem', disabled, onClick, onMouseEnter: onEnter,
    'aria-haspopup': chevron ? 'menu' : undefined, 'aria-expanded': chevron ? !!expanded : undefined,
    children: [
      icon ? jsx(Icon, { d: icon }) : null, label,
      kbd ? jsx('span', { className: 'fa-k', children: kbd }) : null,
      chevron ? jsx('span', { className: 'fa-chev', children: jsx(Icon, { d: P.right, size: 12 }) }) : null,
      children,
    ],
  })
}

function OpenWithMenu({ ctx, t, path, onDone, anchor }) {
  const [apps, setApps] = useState(null)
  const [right, setRight] = useState(false)
  useEffect(() => {
    let live = true
    loadApps(ctx, path).then((a) => live && setApps(a), () => live && setApps([]))
    if (anchor && anchor.current) {
      const r = anchor.current.getBoundingClientRect()
      setRight(window.innerWidth - r.right > 240)
    }
    return () => { live = false }
  }, [ctx, path, anchor])
  return jsxs('div', {
    className: 'fa-menu fa-sub' + (right ? ' fa-r' : ''), role: 'menu', onClick: (e) => e.stopPropagation(),
    children: apps === null
      ? [jsx('div', { className: 'fa-mh', children: t('loading') }, 'l')]
      : apps.length === 0
        ? [jsx('div', { className: 'fa-mh', children: t('noApps') }, 'n')]
        : apps.map((a) => jsx(MenuItem, {
          label: a.name, kbd: a.default ? t('defaultApp') : undefined,
          onClick: () => onDone('openWith', a),
          children: null,
        }, a.path)),
  })
}


// ── scrub player ────────────────────────────────────────────────────────────
// Built for checking a cut, not just watching it: frame-step, J/K/L shuttle, hover filmstrip
// preview on the timeline, speed, loop, and a frame/timecode readout. Keys work while the
// player has focus (click it once), so they never steal the chat composer's keystrokes.
const stripCache = new Map()
const loadStrip = (ctx, p) => cached(stripCache, p, () => withTimeout(ctx, ctx.rest('/strip' + qs(p), { timeoutMs: 70000 }), 72000, 'strip'))
const SPEEDS = [0.25, 0.5, 1, 1.5, 2]

// m:ss·ff — the frame count after a mid-dot, so 2 s + 4 frames reads 0:02·04, never a clock.
export function frameLabel(t, fps) {
  if (!isFinite(t) || t < 0) t = 0
  const whole = Math.floor(t + 1e-6)
  const f = Math.min(Math.round(fps) - 1, Math.floor((t - whole) * fps + 1e-6))
  return `${formatDuration(whole)}·${String(Math.max(0, f)).padStart(2, '0')}`
}

function Player({ ctx, t, src, poster, path, info }) {
  const ref = useRef(null)
  const bar = useRef(null)
  const [time, setTime] = useState(0)
  const [dur, setDur] = useState(info && info.duration ? info.duration : 0)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [loop, setLoop] = useState(false)
  const [muted, setMuted] = useState(false)
  const [hover, setHover] = useState(null)
  const [strip, setStrip] = useState(null)
  const [hint, setHint] = useState(false)
  const shuttle = useRef(0)
  const fps = (info && info.fps) || 24

  useEffect(() => {
    let live = true
    loadStrip(ctx, path).then((s) => live && setStrip(s), () => {})
    return () => { live = false }
  }, [ctx, path])

  useEffect(() => {
    const v = ref.current
    if (!v) return
    const on = (e, f) => v.addEventListener(e, f)
    const tick = () => setTime(v.currentTime)
    on('timeupdate', tick); on('seeked', tick)
    on('loadedmetadata', () => setDur(v.duration || dur))
    on('play', () => setPlaying(true)); on('pause', () => setPlaying(false))
    v.play().catch(() => {})
    let raf = 0
    const loopRaf = () => { if (!v.paused) setTime(v.currentTime); raf = requestAnimationFrame(loopRaf) }
    raf = requestAnimationFrame(loopRaf)
    return () => cancelAnimationFrame(raf)
  }, [])

  const v = () => ref.current
  const seek = (s) => { const el = v(); if (!el) return; el.currentTime = Math.max(0, Math.min(el.duration || dur, s)); setTime(el.currentTime) }
  const step = (n) => { const el = v(); if (!el) return; el.pause(); shuttle.current = 0; seek(el.currentTime + n / fps) }
  const toggle = () => { const el = v(); if (!el) return; shuttle.current = 0; el.playbackRate = rate; el.paused ? el.play() : el.pause() }
  const setSpeed = (r) => { setRate(r); shuttle.current = 0; const el = v(); if (el) el.playbackRate = r }
  const fullscreen = () => { const el = v(); if (el) (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el) }
  const mute = () => { const el = v(); if (el) { el.muted = !el.muted; setMuted(el.muted) } }
  const shuttleBy = (dir) => {
    const el = v(); if (!el) return
    if (dir === 0) { shuttle.current = 0; el.pause(); el.playbackRate = rate; return }
    if (dir < 0) { el.pause(); shuttle.current = 0; seek(el.currentTime - 1); return }   // <video> has no reverse play: J = back 1 s
    shuttle.current = shuttle.current >= 1 ? Math.min(shuttle.current * 2, 8) : 1
    el.playbackRate = shuttle.current; el.play()
  }

  const onKey = (e) => {
    const k = e.key
    const map = {
      ' ': toggle, k: () => shuttleBy(0), K: () => shuttleBy(0), l: () => shuttleBy(1), L: () => shuttleBy(1),
      j: () => shuttleBy(-1), J: () => shuttleBy(-1),
      ArrowLeft: () => (e.shiftKey ? seek(v().currentTime - 1) : step(-1)),
      ArrowRight: () => (e.shiftKey ? seek(v().currentTime + 1) : step(1)),
      ',': () => step(-1), '.': () => step(1), Home: () => seek(0), End: () => seek(dur),
      m: mute, M: mute, f: fullscreen, F: fullscreen, '?': () => setHint((h) => !h),
    }
    if (map[k]) { e.preventDefault(); e.stopPropagation(); map[k]() }
    else if (/^[0-9]$/.test(k)) { e.preventDefault(); e.stopPropagation(); seek((dur * Number(k)) / 10) }
  }

  const pct = dur ? Math.min(100, (time / dur) * 100) : 0
  const posFromEvent = (e) => {
    const r = bar.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left))
    return { x, frac: r.width ? x / r.width : 0, w: r.width }
  }
  const drag = useRef(false)
  const onDown = (e) => { drag.current = true; try { e.currentTarget.setPointerCapture(e.pointerId) } catch {} ; seek(posFromEvent(e).frac * dur) }
  const onMove = (e) => { const p = posFromEvent(e); setHover(p); if (drag.current) seek(p.frac * dur) }
  const onUp = () => { drag.current = false }

  let tip = null
  if (hover && dur) {
    const tw = 128
    const left = Math.max(0, Math.min(hover.w - tw, hover.x - tw / 2))
    let img = null
    if (strip && strip.dataUrl) {
      const i = Math.min(strip.frames - 1, Math.floor(hover.frac * strip.frames))
      const ar = info && info.width && info.height ? info.height / info.width : 9 / 16
      img = jsx('div', { className: 'fa-tipimg', style: {
        backgroundImage: `url(${strip.dataUrl})`, backgroundSize: `${strip.frames * tw}px auto`,
        backgroundPosition: `${-i * tw}px 0`, height: Math.round(tw * ar) + 'px',
      } })
    }
    tip = jsxs('div', { className: 'fa-tip', style: { left: left + 'px', width: tw + 'px' }, children: [img, jsx('span', { children: frameLabel(hover.frac * dur, fps) })] })
  }

  const btn = (label, icon, on, extra) => jsx('button', { type: 'button', className: 'fa-pb' + (extra || ''), 'aria-label': label, title: label, onClick: on, children: icon })
  const svg = (d) => jsx('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'currentColor', 'aria-hidden': true, children: jsx('path', { d }) })
  const IP = {
    play: svg('M4.5 3v10l8.5-5z'), pause: svg('M4 3h3v10H4zM9 3h3v10H9z'),
    back: svg('M3 3h1.6v10H3zM13 3v10L5.5 8z'), fwd: svg('M11.4 3H13v10h-1.6zM3 3v10l7.5-5z'),
    loop: jsx(Icon, { d: 'M3 7V6a2 2 0 0 1 2-2h7l-2-2M13 9v1a2 2 0 0 1-2 2H4l2 2' }),
    vol: jsx(Icon, { d: muted ? 'M2.5 6h2.5L8 3.5v9L5 10H2.5zM11 6l3 4M14 6l-3 4' : 'M2.5 6h2.5L8 3.5v9L5 10H2.5zM10.5 5.5a3.5 3.5 0 0 1 0 5M12.3 3.8a6 6 0 0 1 0 8.4' }),
    full: jsx(Icon, { d: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10' }),
  }

  return jsxs('div', {
    className: 'fa-pl', tabIndex: 0, onKeyDown: onKey, 'aria-label': t('player'),
    children: [
      jsx('video', { ref, className: 'fa-pv', src, poster: poster || undefined, playsInline: true, preload: 'auto', loop, onClick: toggle, onDoubleClick: fullscreen,
        // the clip's own shape: a 9:16 master gets a tall frame (capped), not letterbox bars
        style: info && info.width && info.height ? { aspectRatio: `${info.width} / ${info.height}` } : undefined }),
      jsxs('div', { className: 'fa-pc', children: [
        jsxs('div', {
          ref: bar, className: 'fa-bar', onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerLeave: () => { if (!drag.current) setHover(null) },
          children: [
            jsx('div', { className: 'fa-bar-bg', children: jsx('div', { className: 'fa-bar-fill', style: { width: pct + '%' } }) }),
            jsx('div', { className: 'fa-bar-knob', style: { left: pct + '%' } }),
            tip,
          ],
        }),
        jsxs('div', { className: 'fa-row', children: [
          btn(t('frameBack'), IP.back, () => step(-1)),
          btn(playing ? t('pause') : t('play'), playing ? IP.pause : IP.play, toggle, ' fa-pb-main'),
          btn(t('frameFwd'), IP.fwd, () => step(1)),
          jsx('span', { className: 'fa-tc', children: `${frameLabel(time, fps)} / ${formatDuration(dur)}` }),
          jsx('span', { className: 'fa-sp' }),
          jsx('div', { className: 'fa-speeds', role: 'group', 'aria-label': t('speed'), children: SPEEDS.map((r) =>
            jsx('button', { type: 'button', className: 'fa-sb' + (rate === r ? ' fa-on' : ''), onClick: () => setSpeed(r), children: String(r).replace(/^0\./, '.') + '×' }, r)) }),
          btn(t('loop'), IP.loop, () => setLoop((l) => !l), loop ? ' fa-on' : ''),
          btn(t('mute'), IP.vol, mute),
          btn(t('fullscreen'), IP.full, fullscreen),
          btn(t('keys'), jsx('span', { className: 'fa-q', children: '?' }), () => setHint((h) => !h), hint ? ' fa-on' : ''),
        ] }),
        hint ? jsx('div', { className: 'fa-keys', children: t('keysHelp') }) : null,
      ] }),
    ],
  })
}

// ── one file ───────────────────────────────────────────────────────────────
function FileCard({ path, label, ctx }) {
  const t = useT()
  const [info, setInfo] = useState(null)
  const [thumb, setThumb] = useState(null)
  const [thumbIn, setThumbIn] = useState(false)
  const [menu, setMenu] = useState(false)
  const [sub, setSub] = useState(false)
  const [busy, setBusy] = useState(null)
  const [preview, setPreview] = useState(null)
  const [status, flash, alive] = useStatus(ctx)
  const [copied, setCopied] = useState(false)
  const actsRef = useRef(null)
  const owRef = useRef(null)
  const kind = (info && info.kind) || kindOf(path)
  const missing = info && info.exists === false

  useEffect(() => {
    let live = true
    loadInfo(ctx, path).then((i) => {
      if (!live) return
      setInfo(i)
      // Text files get a type glyph, not a Quick Look render (measured: mostly-blank squares at 64×48).
      if (i && i.exists && (i.kind === 'image' || i.kind === 'video' || i.kind === 'pdf')) {
        loadThumb(ctx, path).then((u) => live && setThumb(u || null), () => {})
      }
    }, () => live && setInfo({ exists: true, kind: kindOf(path), ext: extOf(path) }))
    return () => { live = false }
  }, [ctx, path])

  const closeMenu = useCallback(() => { setMenu(false); setSub(false) }, [])
  useOutside(menu, closeMenu, actsRef)

  const run = useCallback(async (action, arg) => {
    closeMenu()
    if (busy) return
    if (action === 'preview' && preview) { setPreview(null); return }
    setBusy(action)
    try {
      if (action === 'reveal') { await doReveal(ctx, t, path); flash('ok', t('revealed')) }
      else if (action === 'copyPath') { await writeClip(ctx, t, path); flash('ok', t('pathCopied')) }
      else if (action === 'copyText') {
        flash('ok', t('textCopied', await doCopyText(ctx, t, path)))
        setCopied(true)
        if (ctx && ctx.setTimeout) ctx.setTimeout(() => { if (alive.current) setCopied(false) }, 1600)
      }
      else if (action === 'openWith') { await post(ctx, t, '/open-with', { path, app: arg.path }); flash('ok', t('openedWith', arg.name)) }
      else if (action === 'preview') { const p = await loadPreview(ctx, t, path, kind); if (alive.current) setPreview(p) }
    } catch (e) {
      flash('err', String((e && e.message) || e))
    } finally {
      if (alive.current) setBusy(null)
    }
  }, [busy, closeMenu, ctx, flash, kind, path, preview, t, alive])

  const os = hostOs()
  const revealLabel = os === 'mac' ? t('revealMac') : os === 'win' ? t('revealWin') : t('revealOther')
  const textual = TEXT_EXT.has(extOf(path))
  const canPreview = !missing && (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf' || textual)

  const thumbBox = jsxs('button', {
    type: 'button', className: 'fa-thumb', tabIndex: missing ? -1 : 0, 'aria-label': t('preview'),
    onClick: () => { if (!missing && canPreview) run('preview') },
    children: [
      thumb ? jsx('img', { src: thumb, alt: '', className: thumbIn ? 'fa-in' : '', onLoad: () => setThumbIn(true) }) : jsx(Glyph, { kind, ext: extOf(path), missing }),
      kind === 'video' && thumb ? jsx('span', { className: 'fa-play', children: jsx('i', {}) }) : null,
      info && info.duration ? jsx('span', { className: 'fa-dur', children: formatDuration(info.duration) }) : null,
    ],
  })

  const sub2 = missing ? `${t('missing')} · ${t('missingHint')}` : metaLine(info, t) || (extOf(path) || t('file')).toUpperCase()

  const menuEl = menu ? jsxs('div', {
    className: 'fa-menu', role: 'menu',
    children: [
      jsx('div', { className: 'fa-mh', children: t('menuFile') }, 'h'),
      canPreview ? jsx(MenuItem, { icon: P.eye, label: preview ? t('closePreview') : t('preview'), onClick: () => run('preview'), onEnter: () => setSub(false) }, 'p') : null,
      jsxs('div', { ref: owRef, style: { position: 'relative' }, onMouseEnter: () => setSub(true), children: [
        jsx(MenuItem, { icon: P.apps, label: t('openWith'), chevron: true, expanded: sub, onClick: () => setSub((s) => !s) }),
        sub ? jsx(OpenWithMenu, { ctx, t, path, anchor: owRef, onDone: (a, arg) => run(a, arg) }) : null,
      ] }, 'ow'),
      jsx('div', { className: 'fa-sep' }, 's1'),
      jsx(MenuItem, { icon: P.copy, label: t('copyPath'), onClick: () => run('copyPath'), onEnter: () => setSub(false) }, 'cp'),
      jsx(MenuItem, { icon: P.text, label: t('copyText'), disabled: !textual, onClick: () => run('copyText'), onEnter: () => setSub(false) }, 'ct'),
    ],
  }) : null

  return jsxs('div', {
    children: [
      jsx(Style, {}),
      jsxs('div', {
        className: 'fa-card' + (missing ? ' fa-missing' : '') + (kind === 'video' ? ' fa-video' : ''),
        children: [
          thumbBox,
          jsxs('div', { className: 'fa-meta', title: path, children: [
            jsx('span', { className: 'fa-name', children: label || displayName(path) }),
            jsx('span', { className: 'fa-sub', children: missing ? `${t('missing')} · ${t('missingHint')}` : sub2 }),
          ] }),
          missing
            ? jsx('div', { className: 'fa-acts', children: jsx('button', { type: 'button', className: 'fa-pri', onClick: () => run('copyPath'), children: [jsx(Icon, { d: P.copy }, 'i'), t('copyPath')] }) })
            : jsxs('div', { ref: actsRef, className: 'fa-acts', children: [
              textual ? jsx('button', { type: 'button', 'aria-label': t('copyText'), title: t('copyText'), className: 'fa-ib' + (copied ? ' fa-done' : ''), disabled: busy === 'copyText', onClick: () => run('copyText'), children: jsx(Icon, { d: copied ? P.check : P.copy }) }) : null,
              canPreview ? jsx('button', { type: 'button', className: 'fa-ib fa-quiet', 'aria-pressed': !!preview, 'aria-label': preview ? t('closePreview') : t('preview'), title: preview ? t('closePreview') : t('preview'), onClick: () => run('preview'), children: jsx(Icon, { d: P.eye }) }) : null,
              jsxs('button', { type: 'button', className: 'fa-pri', disabled: busy === 'reveal', onClick: () => run('reveal'), children: [jsx(Icon, { d: P.folder }, 'i'), revealLabel] }),
              jsx('button', { type: 'button', className: 'fa-ib', 'aria-label': t('more'), title: t('more'), 'aria-haspopup': 'menu', 'aria-expanded': menu, onClick: () => { setMenu((m) => !m); setSub(false) }, children: jsx(Dots, {}) }),
              menuEl,
            ] }),
        ],
      }),
      jsx(StatusLine, { status }),
      jsx('div', { className: 'fa-exp' + (preview ? ' fa-on' : ''), children: jsx('div', { children: preview
        ? preview.kind === 'video'
          ? jsx(Player, { ctx, t, src: preview.src, poster: preview.poster, path, info })
          : preview.kind === 'audio'
            ? jsx('audio', { className: 'fa-audio', src: preview.src, controls: true, autoPlay: true, preload: 'metadata' })
            : preview.kind === 'image'
              ? jsx('img', { className: 'fa-prev-img', src: preview.url, alt: '' })
              : jsx('pre', { className: 'fa-prev', children: preview.text })
        : null }) }),
    ],
  })
}

// ── many files → one gallery ───────────────────────────────────────────────
function Lightbox({ src, caption, onClose }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k, true)
    return () => document.removeEventListener('keydown', k, true)
  }, [onClose])
  return jsxs('div', { className: 'fa-lb', onClick: onClose, role: 'dialog', 'aria-label': caption, children: [
    jsx('img', { src, alt: caption }), jsx('span', { className: 'fa-cap', children: caption }),
  ] })
}

function Tile({ ctx, path, onOpen }) {
  const [src, setSrc] = useState(null)
  const [on, setOn] = useState(false)
  const [gone, setGone] = useState(false)
  useEffect(() => {
    let live = true
    loadInfo(ctx, path).then((i) => {
      if (!live) return
      if (i && i.exists === false) { setGone(true); return }
      loadThumb(ctx, path).then((u) => live && setSrc(u || null), () => {})
    }, () => {})
    return () => { live = false }
  }, [ctx, path])
  return jsxs('button', {
    type: 'button', className: 'fa-tile' + (gone ? ' fa-gone' : ''), title: displayName(path), disabled: gone,
    onClick: () => !gone && onOpen(path),
    children: [src ? jsx('img', { src, alt: '', className: on ? 'fa-in' : '', onLoad: () => setOn(true) }) : null,
      kindOf(path) === 'video' && src ? jsx('span', { className: 'fa-play', children: jsx('i', {}) }) : null],
  })
}

function Gallery({ paths, ctx }) {
  const t = useT()
  const [menu, setMenu] = useState(false)
  const [lb, setLb] = useState(null)
  const [status, flash] = useStatus(ctx)
  const ref = useRef(null)
  useOutside(menu, () => setMenu(false), ref)
  const imgs = paths.every((p) => kindOf(p) === 'image')
  const os = hostOs()

  const openTile = async (p) => {
    const b = bridge()
    let src = null
    if (kindOf(p) === 'image' && b && b.readFileDataUrl) {
      src = await withTimeout(ctx, b.readFileDataUrl(p), 10000, 'read').catch(() => null)
      if (typeof src !== 'string' || src.indexOf('data:') !== 0) src = null
    }
    if (!src) src = await loadThumb(ctx, p).catch(() => null)
    if (src) setLb({ src, caption: displayName(p) })
  }
  const revealAll = async () => {
    try {
      if (hasNativeReveal() && os !== 'mac') { await doReveal(ctx, t, paths[0]) } else { await post(ctx, t, '/reveal-many', { paths }) }
      flash('ok', t('revealedN', paths.length))
    } catch (e) {
      try { await doReveal(ctx, t, paths[0]); flash('ok', t('revealed')) } catch (e2) { flash('err', String((e2 && e2.message) || e2)) }
    }
  }
  const copyAll = async () => {
    setMenu(false)
    try { await writeClip(ctx, t, paths.join('\n')); flash('ok', t('pathsCopied', paths.length)) } catch (e) { flash('err', String((e && e.message) || e)) }
  }
  const exts = [...new Set(paths.map((p) => extOf(p).toUpperCase()).filter(Boolean))].join(', ')

  return jsxs('div', { children: [
    jsx(Style, {}),
    jsxs('div', { className: 'fa-gal', children: [
      jsx('div', { className: 'fa-grid', children: paths.map((p) => jsx(Tile, { ctx, path: p, onOpen: openTile }, p)) }),
      jsxs('div', { className: 'fa-gft', children: [
        jsx('span', { className: 'fa-sub', children: `${imgs ? t('images', paths.length) : t('files', paths.length)}${exts ? ' · ' + exts : ''}` }),
        jsxs('div', { ref, className: 'fa-acts', children: [
          jsxs('button', { type: 'button', className: 'fa-pri', onClick: revealAll, children: [jsx(Icon, { d: P.folder }, 'i'), os === 'mac' ? t('revealAllMac') : t('revealAllOther')] }),
          jsx('button', { type: 'button', className: 'fa-ib', 'aria-label': t('more'), 'aria-haspopup': 'menu', 'aria-expanded': menu, onClick: () => setMenu((m) => !m), children: jsx(Dots, {}) }),
          menu ? jsx('div', { className: 'fa-menu', role: 'menu', children: jsx(MenuItem, { icon: P.copy, label: t('copyPaths', paths.length), onClick: copyAll }) }) : null,
        ] }),
      ] }),
    ] }),
    jsx(StatusLine, { status }),
    lb ? jsx(Lightbox, { src: lb.src, caption: lb.caption, onClose: () => setLb(null) }) : null,
  ] })
}

export function parsePaths(attrs) {
  const many = attrs && (attrs.paths || attrs.files)
  if (many) return String(many).split('|').map(normalizePath).filter((p) => p && p.indexOf('/') !== -1)
  const one = normalizePath(attrs && (attrs.path || attrs.file || attrs.src))
  return one && one.indexOf('/') !== -1 ? [one] : []
}

export default {
  id: PLUGIN_ID,
  name: 'File actions',
  description: 'Quiet, rich file cards: live thumbnail, Show in Finder, and Preview / Open with / Copy behind ⋯.',
  register(ctx) {
    const render = ({ attrs }) => {
      const paths = parsePaths(attrs)
      if (paths.length === 0) return null
      if (paths.length > 1) return jsx(Gallery, { paths, ctx })
      return jsx(FileCard, { path: paths[0], label: attrs && (attrs.label || attrs.name), ctx })
    }
    ctx.register({ id: 'directive', area: TRANSCRIPT_DIRECTIVE_AREA, data: { name: 'file-actions', render } })
    ctx.register({ id: 'directive-legacy', area: TRANSCRIPT_DIRECTIVE_AREA, data: { name: 'finder-reveal', render } })
  },
}
