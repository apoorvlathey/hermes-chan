/** Files a bot attaches to its reply. Hermes marks them with `MEDIA:<path>` tags (on their own line, or
 *  inline), which messaging platforms turn into real attachments; here they become images, players and
 *  file chips under the message. The paths are on the bot's machine and are read through its gateway. */

export type MediaKind = 'image' | 'audio' | 'video' | 'text' | 'file'

const KIND: Record<string, MediaKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', opus: 'audio', flac: 'audio',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video',
  md: 'text', markdown: 'text', txt: 'text', log: 'text', json: 'text', csv: 'text', yaml: 'text', yml: 'text', toml: 'text', diff: 'text', patch: 'text'
}

export const extOf = (path: string) => {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export const nameOf = (path: string) => path.split(/[\\/]/).pop() || path

export const mediaKind = (path: string): MediaKind => KIND[extOf(path)] ?? 'file'

// `MEDIA:/path`, `MEDIA: "~/a b.png"`, `` `MEDIA:/x` ``; a path must look like one (absolute or ~/).
const PATH = String.raw`(?:"([^"\n]+)"|'([^'\n]+)'|\x60([^\x60\n]+)\x60|((?:~\/|\/)[^\s\x60"']+))`
// The whole tag wrapped in quotes or backticks: the path may contain spaces.
const WRAPPED_RE = /\x60MEDIA:[ \t]*([^\x60\n]+)\x60|"MEDIA:[ \t]*([^"\n]+)"|'MEDIA:[ \t]*([^'\n]+)'/g
const LINE_RE = new RegExp(String.raw`^[ \t]*MEDIA:[ \t]*${PATH}[ \t]*$`, 'gm')
const INLINE_RE = new RegExp(String.raw`MEDIA:[ \t]*${PATH}`, 'g')

/** The message without its `MEDIA:` tags, and the paths they named (in order, no repeats). While a
 *  reply streams, a tag still being written at the very end is held back rather than read. */
export function splitMedia(text: string, streaming = false): { text: string; media: string[] } {
  if (!text.includes('MEDIA:')) return { text, media: [] }
  let src = text
  if (streaming) src = src.replace(/[\x60"']?MEDIA:[^\n]*$/, '')
  const media: string[] = []
  const take = (...groups: (string | undefined)[]) => {
    const p = groups.find(Boolean)?.trim().replace(/[.,;:!?)]+$/, '')
    if (p && /^(~\/|\/)/.test(p) && !media.includes(p)) media.push(p)
    return ''
  }
  let out = src.replace(WRAPPED_RE, (_m, a, b, c) => take(a, b, c))
  out = out.replace(LINE_RE, (_m, a, b, c, d) => take(a, b, c, d))
  out = out.replace(INLINE_RE, (_m, a, b, c, d) => take(a, b, c, d))
  return { text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), media }
}
