/** Presentation rules for stored transcript rows, ported from Hermes Desktop's hydration
 *  (apps/desktop/src/lib/chat-messages/hydration.ts), plus a Hermes Desktop customization's rules for
 *  cron reports and the memory-context projection.
 *  Display only: nothing here changes what the model saw or what is stored. */

const ATTACHED_CONTEXT_MARKER_RE = /(?:^|\n)--- Attached Context ---\s*\n/
const CONTEXT_WARNINGS_MARKER_RE = /(?:^|\n)--- Context Warnings ---[\s\S]*$/
const LEGACY_HEARTBEAT_ROW_RE = /^\[Background process \S+ heartbeat #\d+ /
export const CONTEXT_REF_RE = /@(file|folder|url|image|tool|terminal):(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\S+)/g

// agent/memory_manager.py::build_memory_context_block, flattened into legacy multimodal user rows.
const MEMORY_OPEN =
  "<memory-context>\n[System note: The following is recalled memory context, NOT new user input. Treat as authoritative reference data — this is the agent's persistent memory and should inform all responses.]\n\n"

const CRON_HEADER_RE = /^\[Cron job "([^"\r\n]+)" report: shown in the chat, no reply asked for\]\r?\n\r?\n/

function insideCodeFence(text: string): boolean {
  let fence: string | undefined
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (!m) continue
    if (!fence) fence = m[1]
    else if (m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = undefined
  }
  return fence !== undefined
}

/** Drop a trailing injected memory-context block (exact generated wrapper only). */
function stripMemoryContext(text: string): string {
  const start = text.lastIndexOf(MEMORY_OPEN)
  if (start < 0 || !text.endsWith('\n</memory-context>') || insideCodeFence(text.slice(0, start))) return text
  return text.slice(0, start).trimEnd()
}

const IMAGE_MARKER_RE = /^\[Image attached(?: at)?: ([^\n\]]+)\]\s*$/
const IMAGE_REF_RE = /@image:(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|(\S+))/g

/** What the user typed, when Hermes recorded it apart from the turn's content. A plugin can append its
 *  own instructions to the stored message (the Conduit plugin adds a "Bot workstreams." brief when an
 *  image is attached), but `display_metadata.typed_ask` keeps the user's words and image lines. */
export function typedAsk(m: { display_metadata?: unknown }): string | null {
  const v = parseMetadata(m.display_metadata)?.typed_ask
  return typeof v === 'string' && v.trim() ? v : null
}

/** User text plus the gateway paths of the images sent with it. Images persist as
 *  `[Image attached at: <path>]` + `[screenshot]` lines (ingress) or `@image:` refs (older rows). */
export function userDisplay(raw: string): { text: string; images: string[] } | null {
  const images: string[] = []
  const kept = raw
    .split('\n')
    .filter(line => {
      const m = IMAGE_MARKER_RE.exec(line)
      if (m) images.push(m[1]!.trim())
      return !m && line.trim() !== '[screenshot]'
    })
    .join('\n')
  const visible = userDisplayText(kept)
  if (visible === null) return null
  const text = visible
    .replace(IMAGE_REF_RE, (_w, a, b, c, d) => {
      images.push(a ?? b ?? c ?? d)
      return ''
    })
    .trim()
  return { text, images: [...new Set(images)] }
}

/** What the user actually typed: no attached-context dump, no context warnings, no memory block.
 *  Refs that only appear in the attached block are hoisted to the front so they still chip. */
export function userDisplayText(raw: string): string | null {
  if (LEGACY_HEARTBEAT_ROW_RE.test(raw.trim())) return null
  const text = stripMemoryContext(raw)
  const marker = text.match(ATTACHED_CONTEXT_MARKER_RE)
  if (!marker || marker.index === undefined) return text.replace(CONTEXT_WARNINGS_MARKER_RE, '').trim()

  const visible = text.slice(0, marker.index).replace(CONTEXT_WARNINGS_MARKER_RE, '').trim()
  const attached = text.slice(marker.index + marker[0].length)
  const refs = [...new Set([...attached.matchAll(CONTEXT_REF_RE)].map(m => m[0]))]
  const missing = refs.filter(r => !visible.includes(r))
  return [missing.join('\n'), visible].filter(Boolean).join('\n\n') || visible
}

export function parseMetadata(meta: unknown): Record<string, any> | null {
  let v = meta
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  return v && typeof v === 'object' ? (v as Record<string, any>) : null
}

function isCronIdentity(identity: unknown): boolean {
  if (typeof identity !== 'string') return false
  try {
    const v: unknown = JSON.parse(identity)
    return Array.isArray(v) && v.length === 3 && v[0] === 'cron' && v.every(p => typeof p === 'string' && p.length > 0)
  } catch {
    return false
  }
}

/** A scheduled-job report delivered into the chat. Stored as a `user` row for the model, but it's the
 *  bot talking, so it renders as a bot message. Requires producer proof, never just the header text. */
export function cronReport(m: { role: string; display_kind?: string | null; display_metadata?: unknown }, text: string) {
  if (m.role !== 'user' || m.display_kind !== 'internal_notification' || !text) return null
  const meta = parseMetadata(m.display_metadata)
  const notes = meta?.completion_note
  const ownerCron = Array.isArray(notes) && notes.length > 0 && notes.every(isCronIdentity)
  if (meta?.conduit_cron_report !== true && !ownerCron) return null
  const header = CRON_HEADER_RE.exec(text)
  return header ? { jobName: header[1]!, text: text.slice(header[0].length) } : null
}

/** "[bot:default] Email checks (5min) and hourly discovery" → "Email checks (5min) and hourly discovery" */
export const humanJobName = (name: string) => name.replace(/^\[bot:[^\]]*\]\s*/, '').trim() || name

/** Split user text into plain runs and context refs (`@url:`…), for chips. */
export function splitRefs(text: string): ({ kind: 'text'; text: string } | { kind: 'ref'; type: string; value: string })[] {
  const out: ({ kind: 'text'; text: string } | { kind: 'ref'; type: string; value: string })[] = []
  let last = 0
  for (const m of text.matchAll(CONTEXT_REF_RE)) {
    if (m.index! > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    const raw = m[0].slice(m[1]!.length + 2)
    out.push({ kind: 'ref', type: m[1]!, value: raw.replace(/^["'`]|["'`]$/g, '') })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}
