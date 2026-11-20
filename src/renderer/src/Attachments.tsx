/** What a bot attached to its reply (`MEDIA:` tags): images inline (click for full size), audio and
 *  video players that load on demand, text files that open in a preview, and anything else as a file
 *  you can save to Downloads. Files live on the bot's machine and come through its gateway. */
import { useEffect, useState } from 'react'

import { hermes } from './bridge'
import { Markdown } from './Chat'
import { extOf, mediaKind, nameOf, type MediaKind } from './mediaTags'

/** Files fetched once per bot and path, shared by every message that shows them. */
const files = new Map<string, Promise<string>>()
export function gatewayFile(botId: string, path: string): Promise<string> {
  const key = `${botId}:${path}`
  let p = files.get(key)
  if (!p) {
    p = hermes.readDataUrl(botId, path)
    files.set(key, p)
    p.catch(() => files.delete(key))
  }
  return p
}

function useFile(botId: string, path: string, enabled = true) {
  const [state, setState] = useState<{ src?: string; error?: string }>({})
  useEffect(() => {
    if (!enabled) return
    let live = true
    gatewayFile(botId, path)
      .then(src => live && setState({ src }))
      .catch(err => live && setState({ error: (err as Error).message || 'Couldn’t load it' }))
    return () => {
      live = false
    }
  }, [botId, path, enabled])
  return state
}

export function MediaAttachments({ botId, paths }: { botId: string; paths: string[] }) {
  const [viewing, setViewing] = useState<string | null>(null)
  const images = paths.filter(p => mediaKind(p) === 'image')
  const others = paths.filter(p => mediaKind(p) !== 'image')
  return (
    <div className="media">
      {images.length > 0 && (
        <div className={`media-images ${images.length > 1 ? 'grid' : ''}`}>
          {images.map(p => (
            <MediaImage key={p} botId={botId} path={p} onOpen={() => setViewing(p)} />
          ))}
        </div>
      )}
      {others.map(p => (
        <MediaFile key={p} botId={botId} path={p} kind={mediaKind(p)} />
      ))}
      {viewing && <Viewer botId={botId} path={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

function MediaImage({ botId, path, onOpen }: { botId: string; path: string; onOpen: () => void }) {
  const { src, error } = useFile(botId, path)
  if (error) return <MediaFile botId={botId} path={path} kind="image" note={error} />
  return (
    <button className="media-img" onClick={onOpen} disabled={!src} title={`${nameOf(path)} · click to enlarge`}>
      {src ? <img src={src} alt={nameOf(path)} /> : <span className="media-img-loading shimmer-box" />}
    </button>
  )
}

const ICON: Record<MediaKind, string> = {
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10.5 6.5h.01',
  audio: 'M6 11.5V4l7-1.5v7.5M6 11.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM13 10a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  video: 'M2.5 4h8v8h-8zM10.5 7l3-2v6l-3-2',
  text: 'M4 2h5.5L12.5 5v9h-8.5zM9 2v3.5h3.5M6 8h4.5M6 10.5h4.5',
  file: 'M4 2h5.5L12.5 5v9h-8.5zM9 2v3.5h3.5'
}

function Glyph({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

/** A non-image attachment: a row with its name and type; audio/video play inline once loaded, text opens
 *  a preview, and everything can be saved to Downloads. */
function MediaFile({ botId, path, kind, note }: { botId: string; path: string; kind: MediaKind; note?: string }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')
  const [saveError, setSaveError] = useState('')
  const playable = kind === 'audio' || kind === 'video'
  const { src, error } = useFile(botId, path, open && (playable || kind === 'text'))

  const save = async () => {
    setSaving('busy')
    try {
      await hermes.saveFile(botId, path)
      setSaving('done')
    } catch (err) {
      setSaving('failed')
      setSaveError((err as Error).message)
    }
  }

  const ext = extOf(path)
  const action = kind === 'text' ? (open ? 'Hide' : 'Preview') : playable ? (open ? 'Hide' : kind === 'audio' ? 'Play' : 'Play video') : null
  return (
    <div className="media-file-wrap">
      <div className="media-file" title={path}>
        <span className="media-file-icon">
          <Glyph d={ICON[kind]} />
        </span>
        <span className="media-file-text">
          <span className="media-file-name">{nameOf(path)}</span>
          <span className={`media-file-meta ${note || saving === 'failed' ? 'bad' : ''}`}>
            {note ?? (saving === 'failed' ? saveError || 'Couldn’t save it' : saving === 'done' ? 'Saved to Downloads' : ext ? ext.toUpperCase() : 'File')}
          </span>
        </span>
        {action && !note && (
          <button className="media-btn" onClick={() => setOpen(o => !o)}>
            {action}
          </button>
        )}
        <button className="media-btn" onClick={() => void save()} disabled={saving === 'busy'} title="Save to Downloads">
          {saving === 'busy' ? 'Saving…' : saving === 'done' ? 'Saved' : 'Save'}
        </button>
      </div>
      {open && (
        <div className="media-open">
          {error ? (
            <p className="media-error">{error}</p>
          ) : !src ? (
            <div className="media-img-loading shimmer-box" />
          ) : kind === 'audio' ? (
            <audio src={src} controls autoPlay />
          ) : kind === 'video' ? (
            <video src={src} controls autoPlay />
          ) : (
            <TextPreview botId={botId} dataUrl={src} markdown={ext === 'md' || ext === 'markdown'} />
          )}
        </div>
      )}
    </div>
  )
}

function decode(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  const body = dataUrl.slice(comma + 1)
  if (!dataUrl.slice(0, comma).includes(';base64')) return decodeURIComponent(body)
  const bin = atob(body)
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)))
}

function TextPreview({ botId, dataUrl, markdown }: { botId: string; dataUrl: string; markdown: boolean }) {
  const text = decode(dataUrl)
  return <div className="media-text">{markdown ? <Markdown text={text} botId={botId} /> : <pre>{text}</pre>}</div>
}

/** An image at full size over the app; Esc or a click outside closes it. */
function Viewer({ botId, path, onClose }: { botId: string; path: string; onClose: () => void }) {
  const { src } = useFile(botId, path)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="media-viewer" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="media-viewer-bar">
        <span className="media-viewer-name" title={path}>
          {nameOf(path)}
        </span>
        <button className="media-btn" onClick={() => void hermes.saveFile(botId, path).then(() => setSaved(true))}>
          {saved ? 'Saved' : 'Save'}
        </button>
        <button className="media-btn" onClick={onClose} title="Close (Esc)">
          Close
        </button>
      </div>
      {src && <img src={src} alt={nameOf(path)} onMouseDown={e => e.stopPropagation()} />}
    </div>
  )
}
