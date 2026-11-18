/** App state + all gateway plumbing for the renderer. A tiny external store (no deps) read with
 *  `useStore(selector)`. Threads are keyed `${botId}:${rootSessionId}`. */
import { useRef, useSyncExternalStore } from 'react'

import type { AppConfig, BotStatus, GatewayEventEnvelope, ServerRequestEnvelope, Workstream } from '../../shared/types'
import { hermes } from './bridge'
import { applyFastAfterCreate, applyInfo, createParamsFor, fencedMutate, knownGeneration, loadSessionModel, type ModelPick, noteFence } from './models'
import { cronReport, humanJobName, typedAsk, userDisplay } from './transcript'


// ─── types ──────────────────────────────────────────────────────────────────────────────────────

export interface Bot {
  id: string
  name: string
  color: string
  description?: string
  avatar?: string
  model?: string
  /** The profile's forever Bot Chat. */
  canonical?: { id: string; resumeId: string; lastActive: number; preview?: string }
}

export interface SessionRow {
  key: string
  botId: string
  id: string
  resumeId: string
  title: string
  source: string
  preview: string
  lastReply: string
  lastActive: number
  messageCount: number
  running: boolean
  pinned: boolean
}

/** Something waiting in the composer to go out with the next message. */
export interface Draft {
  id: string
  kind: 'image' | 'file'
  name: string
  mime: string
  size: number
  dataUrl: string
}

export interface ToolInfo {
  toolId?: string
  name: string
  label: string
  emoji?: string
  preview?: string
  done: boolean
  duration?: number
}

export type Item =
  | {
      kind: 'user'
      id: string
      text: string
      ts?: number
      /** Data URLs of images sent from this window (instant preview). */
      images?: string[]
      /** Gateway-side paths of images in stored history (loaded lazily). */
      imagePaths?: string[]
      files?: string[]
    }
  | { kind: 'assistant'; id: string; text: string; ts?: number; streaming?: boolean; report?: string }
  | { kind: 'tool'; id: string; tool: ToolInfo; ts?: number }
  | { kind: 'note'; id: string; text: string; tone?: 'error' | 'info'; ts?: number }

export interface Thread {
  key: string
  botId: string
  rootId?: string
  liveId?: string
  title: string
  isBotChat: boolean
  loading: boolean
  items: Item[]
  running: boolean
  thinking: boolean
  status?: string
  error?: string
  /** The running turn was submitted from this window (vs. a cron report or another device). */
  localTurn?: boolean
  /** The session's model pick (from session.info), or the pending pick for a chat not created yet. */
  model?: ModelPick
}

export interface Prompt {
  key: string
  botId: string
  sessionId: string
  kind: 'approval' | 'clarify'
  /** Canonical gateways: event-borne prompts answered over RPC. */
  promptId?: string
  generation?: number
  /** Legacy path: a server→client JSON-RPC request answered over the same socket. */
  requestId?: string
  command?: string
  description?: string
  question?: string
  questions?: { qid: string; question: string; choices?: string[] | null }[]
  choices?: string[]
}

export type View = { kind: 'bot'; botId: string } | { kind: 'session'; key: string } | { kind: 'new'; botId: string }

interface State {
  config: AppConfig | null
  statuses: Record<string, BotStatus>
  bots: Record<string, Bot>
  sessions: Record<string, SessionRow[]>
  threads: Record<string, Thread>
  live: Record<string, string>
  prompts: Prompt[]
  view: View | null
  seen: Record<string, number>
  showRoutine: boolean
  /** Local order of pinned rows (row keys); the pin itself lives on the session in Hermes. */
  pinOrder: string[]
  /** The bots/setup screen is open over the app. */
  setupOpen: boolean
  search: string
  windowFocused: boolean
  /** Each bot's workstreams (Conduit plugin), when loaded. */
  workstreams: Record<string, Workstream[]>
  /** The workstreams panel on the right is open. */
  showWorkstreams: boolean
}

// ─── store core ─────────────────────────────────────────────────────────────────────────────────

const SEEN_KEY = 'hermes-chan.seen.v1'
const PIN_ORDER_KEY = 'hermes-chan.pinOrder.v1'
const PREFS_KEY = 'hermes-chan.prefs.v1'

const readJson = <T>(k: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(k)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const prefs = readJson<{ showRoutine?: boolean; lastBot?: string; showWorkstreams?: boolean }>(PREFS_KEY, {})

let state: State = {
  config: null,
  statuses: {},
  bots: {},
  sessions: {},
  threads: {},
  live: {},
  prompts: [],
  view: null,
  seen: readJson(SEEN_KEY, {}),
  showRoutine: prefs.showRoutine ?? false,
  pinOrder: readJson<string[]>(PIN_ORDER_KEY, []),
  setupOpen: false,
  search: '',
  windowFocused: document.hasFocus(),
  workstreams: {},
  showWorkstreams: prefs.showWorkstreams ?? true
}

const listeners = new Set<() => void>()

function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  if ('seen' in next) localStorage.setItem(SEEN_KEY, JSON.stringify(state.seen))
  if ('pinOrder' in next) localStorage.setItem(PIN_ORDER_KEY, JSON.stringify(state.pinOrder))
  for (const l of listeners) l()
}

export const getState = () => state

const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Selector hook. Results are cached per (state, selector) so derived arrays don't loop React. */
export function useStore<T>(sel: (s: State) => T): T {
  const cache = useRef<{ s: State; sel: (s: State) => T; v: T } | null>(null)
  const get = () => {
    const c = cache.current
    if (c && c.s === state && c.sel === sel) return c.v
    const v = sel(state)
    cache.current = { s: state, sel, v }
    return v
  }
  return useSyncExternalStore(subscribe, get)
}

const savePrefs = (p: Partial<typeof prefs>) => {
  Object.assign(prefs, p)
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
}

let uid = 0
const nid = () => `i${++uid}`

function patchThread(key: string, fn: (t: Thread) => Partial<Thread>) {
  set(s => {
    const t = s.threads[key]
    if (!t) return {}
    return { threads: { ...s.threads, [key]: { ...t, ...fn(t) } } }
  })
}

export const patchThreadPublic = (key: string, fn: (t: Thread) => Partial<Thread>) => patchThread(key, fn)

// ─── derived helpers ────────────────────────────────────────────────────────────────────────────

export const threadKey = (botId: string, rootId: string) => `${botId}:${rootId}`

export const focusedKey = (s: State = state): string | null => {
  const v = s.view
  if (!v) return null
  if (v.kind === 'session') return v.key
  if (v.kind === 'bot') {
    const c = s.bots[v.botId]?.canonical
    return c ? threadKey(v.botId, c.id) : `${v.botId}:botchat`
  }
  return `${v.botId}:new`
}

export const isUnread = (key: string, lastActive: number, s: State = state) => {
  if (s.windowFocused && focusedKey(s) === key) return false
  const seen = s.seen[key]
  return seen !== undefined && lastActive > seen + 1
}

export const botUnread = (bot: Bot, s: State = state) =>
  bot.canonical ? isUnread(threadKey(bot.id, bot.canonical.id), bot.canonical.lastActive, s) : false

export const botBusy = (botId: string, s: State = state) =>
  Object.values(s.threads).some(t => t.botId === botId && t.running)

function markSeen(key: string, ts = Date.now() / 1000) {
  if ((state.seen[key] ?? 0) >= ts) return
  set(s => ({ seen: { ...s.seen, [key]: ts } }))
}

const isRoutine = (r: { source: string; title: string }, hidden: string[]) =>
  hidden.includes(r.source) || r.title.startsWith('[bot:')

const matchesSearch = (r: SessionRow, q: string) => !q || `${r.title} ${r.preview} ${r.lastReply}`.toLowerCase().includes(q)

/** Pinned chats in your drag order; pins without a slot (pinned elsewhere) follow, newest first. */
export function pinnedSessions(s: State = state): SessionRow[] {
  const q = s.search.trim().toLowerCase()
  const rows = Object.values(s.sessions).flat().filter(r => r.pinned && matchesSearch(r, q))
  const rank = new Map(s.pinOrder.map((k, i) => [k, i]))
  return rows.sort((a, b) => {
    // Pins you've placed (or just pinned) keep their slot; pins from elsewhere follow, newest first.
    const ra = rank.get(a.key) ?? Infinity
    const rb = rank.get(b.key) ?? Infinity
    if (ra !== rb) return ra === Infinity ? 1 : rb === Infinity ? -1 : ra - rb
    return b.lastActive - a.lastActive
  })
}

export function visibleSessions(s: State = state): SessionRow[] {
  const hidden = s.config?.hiddenSources ?? []
  const q = s.search.trim().toLowerCase()
  const rows = Object.values(s.sessions).flat()
  return rows
    .filter(r => !r.pinned)
    .filter(r => r.messageCount > 0 || r.running)
    .filter(r => s.showRoutine || !isRoutine(r, hidden))
    .filter(r => !q || `${r.title} ${r.preview} ${r.lastReply}`.toLowerCase().includes(q))
    .sort((a, b) => b.lastActive - a.lastActive)
}

export function hiddenRoutineCount(s: State = state): number {
  const hidden = s.config?.hiddenSources ?? []
  return Object.values(s.sessions)
    .flat()
    .filter(r => r.messageCount > 0 && isRoutine(r, hidden)).length
}

// ─── loading bots + session lists ───────────────────────────────────────────────────────────────

const avatarRequested = new Set<string>()

async function refreshBot(botId: string) {
  const cfg = state.config?.bots.find(b => b.id === botId)
  if (!cfg) return
  const profile = cfg.transport.profile
  try {
    // The stored picker lists closed sessions; sessions open in a gateway process are 'live'. Merge both.
    const [profiles, stored, live] = await Promise.all([
      hermes.request<{ profiles: any[] }>(botId, 'profiles.list', {}),
      hermes.request<{ sessions: any[] }>(botId, 'session.list', { scope: 'stored', picker: true, limit: 200 }),
      hermes.request<{ sessions: any[] }>(botId, 'session.list', { picker: true, limit: 200 }).catch(() => ({ sessions: [] }))
    ])
    const byId = new Map<string, any>()
    for (const r of [...stored.sessions, ...live.sessions]) {
      const prev = byId.get(r.id)
      byId.set(r.id, prev ? { ...prev, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== '')) } : r)
    }
    const list = { sessions: [...byId.values()] }
    const p = profiles.profiles.find(x => x.name === profile) ?? profiles.profiles.find(x => x.is_default)
    const meta = p?.ui_meta?.['hermes-bots'] ?? {}
    const canon = p?.canonical_session
    const bot: Bot = {
      id: botId,
      name: p?.display_name || meta.title || cfg.name || profile,
      color: meta.color || cfg.color || 'hsl(45 90% 60%)',
      description: meta.description || p?.description,
      model: p?.model,
      avatar: state.bots[botId]?.avatar,
      canonical: canon
        ? { id: canon.id, resumeId: canon.resolved_id || canon.id, lastActive: canon.last_active || 0, preview: canon.preview }
        : undefined
    }
    const rows: SessionRow[] = list.sessions
      .filter(r => !canon || (r.id !== canon.id && r.session_id !== canon.resolved_id))
      .map(r => ({
        key: threadKey(botId, r.id),
        botId,
        id: r.id,
        resumeId: r.resolved_id || r.session_id || r.id,
        title: r.title || r.root_title || '',
        source: r.source || '',
        preview: r.preview || '',
        lastReply: r.last_reply || '',
        lastActive: r.last_active_at || r.started_at || 0,
        messageCount: r.message_count || 0,
        running: !!r.running,
        pinned: !!r.pinned
      }))

    // First sight of a row: treat as already read so a fresh install isn't a wall of dots.
    const seen = { ...state.seen }
    let seenChanged = false
    const prime = (key: string, ts: number) => {
      if (seen[key] === undefined) {
        seen[key] = ts
        seenChanged = true
      }
    }
    rows.forEach(r => prime(r.key, r.lastActive))
    if (bot.canonical) prime(threadKey(botId, bot.canonical.id), bot.canonical.lastActive)

    set(s => ({
      bots: { ...s.bots, [botId]: bot },
      sessions: { ...s.sessions, [botId]: rows },
      ...(seenChanged ? { seen } : {})
    }))

    if (p?.has_avatar && !avatarRequested.has(botId)) {
      avatarRequested.add(botId)
      hermes
        .request<{ data?: string }>(botId, 'profiles.get_asset', { name: p.name, asset: 'avatar' })
        .then(a => a.data && set(s => ({ bots: { ...s.bots, [botId]: { ...s.bots[botId], avatar: a.data } } })))
        .catch(() => avatarRequested.delete(botId))
    }
  } catch (err) {
    console.warn('refresh failed', botId, err)
  }
}

const refreshTimers = new Map<string, number>()
export function scheduleRefresh(botId: string, delay = 600) {
  clearTimeout(refreshTimers.get(botId))
  refreshTimers.set(botId, window.setTimeout(() => void refreshBot(botId), delay))
}

// ─── transcript mapping ─────────────────────────────────────────────────────────────────────────

function textOf(m: any): string {
  if (typeof m.text === 'string') return m.text
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('')
  }
  return ''
}

function toolFromLabels(m: any): ToolInfo {
  const label = Array.isArray(m.labels) && m.labels[0]
  return {
    toolId: m.tool_call_id,
    name: m.name,
    label: label?.text || m.context || prettyTool(m.name),
    emoji: label?.emoji,
    preview: label?.preview || undefined,
    done: true
  }
}

export const prettyTool = (name: string) =>
  (name || 'tool').replace(/^mcp_/, '').replace(/[_.]+/g, ' ').replace(/^\w/, c => c.toUpperCase())

function mapMessages(messages: any[]): Item[] {
  const out: Item[] = []
  for (const m of messages) {
    const ts = m.timestamp ?? undefined
    if (m.role === 'user') {
      const raw = typeof m.display_content === 'string' ? m.display_content : textOf(m)
      if (m.display_kind === 'hidden' || !raw) continue
      const report = cronReport(m, raw)
      if (report) {
        out.push({ kind: 'assistant', id: nid(), text: report.text, ts, report: humanJobName(report.jobName) })
      } else if (m.display_kind && m.display_kind !== 'user') {
        out.push({ kind: 'note', id: nid(), text: raw, ts })
      } else {
        const shown = userDisplay(typedAsk(m) ?? raw)
        if (shown && (shown.text || shown.images.length)) {
          out.push({ kind: 'user', id: nid(), text: shown.text, ts, ...(shown.images.length ? { imagePaths: shown.images } : {}) })
        }
      }
    } else if (m.role === 'assistant') {
      const text = textOf(m)
      if (text.trim()) out.push({ kind: 'assistant', id: nid(), text, ts })
    } else if (m.role === 'tool') {
      out.push({ kind: 'tool', id: nid(), tool: toolFromLabels(m), ts })
    } else if (m.display_kind) {
      const text = textOf(m)
      if (text) out.push({ kind: 'note', id: nid(), text, ts })
    }
  }
  return out
}

// ─── opening threads ────────────────────────────────────────────────────────────────────────────

async function attach(key: string, botId: string, resumeId: string) {
  try {
    const res = await hermes.request<any>(botId, 'session.resume', { session_id: resumeId })
    const items = mapMessages(res.messages ?? [])
    const inflight = res.inflight
    if (inflight?.assistant) items.push({ kind: 'assistant', id: nid(), text: inflight.assistant, streaming: !!inflight.streaming })
    const running = !!(res.running ?? res.info?.running)
    set(s => ({
      live: { ...s.live, [`${botId}:${res.session_id}`]: key },
      threads: {
        ...s.threads,
        [key]: {
          ...s.threads[key],
          liveId: res.session_id,
          title: res.info?.title || s.threads[key]?.title || '',
          loading: false,
          items,
          running,
          thinking: running && !inflight?.assistant
        }
      }
    }))
    noteFence(botId, res.session_id, res.revision, res.execution_generation ?? res.info?.execution_generation)
    void loadSessionModel(key, botId, res.session_id)
    const pa = res.pending_approval
    if (pa?.request_id) {
      addPrompt({ key: `${botId}:${pa.request_id}`, botId, sessionId: res.session_id, kind: 'approval', requestId: pa.request_id, command: pa.command, description: pa.description, choices: pa.choices })
    }
  } catch (err) {
    patchThread(key, () => ({ loading: false, error: (err as Error).message }))
  }
}

function ensureThread(key: string, init: Partial<Thread> & { botId: string }) {
  if (state.threads[key]) return false
  set(s => ({
    threads: {
      ...s.threads,
      [key]: { key, title: '', isBotChat: false, loading: true, items: [], running: false, thinking: false, ...init }
    }
  }))
  return true
}

export function openBot(botId: string) {
  savePrefs({ lastBot: botId })
  set({ view: { kind: 'bot', botId } })
  const bot = state.bots[botId]
  if (!bot?.canonical) {
    const key = `${botId}:botchat`
    ensureThread(key, { botId, isBotChat: true, loading: false, title: 'Bot Chat' })
    return
  }
  const key = threadKey(botId, bot.canonical.id)
  markSeen(key)
  if (ensureThread(key, { botId, rootId: bot.canonical.id, isBotChat: true, title: 'Bot Chat' })) {
    void attach(key, botId, bot.canonical.resumeId)
  }
}

export function openSession(row: SessionRow) {
  set({ view: { kind: 'session', key: row.key } })
  markSeen(row.key, Math.max(row.lastActive, Date.now() / 1000))
  if (ensureThread(row.key, { botId: row.botId, rootId: row.id, title: row.title })) {
    void attach(row.key, row.botId, row.resumeId)
  }
}

/** Find the bot that owns `profile` (preferring the one the link was clicked in). */
function botForProfile(profile: string | undefined, fromBotId?: string): string | undefined {
  const bots = state.config?.bots ?? []
  const from = bots.find(b => b.id === fromBotId)
  if (!profile || from?.transport.profile === profile) return from?.id ?? bots[0]?.id
  return bots.find(b => b.transport.profile === profile)?.id ?? from?.id
}

/** Look up a session row anywhere in the loaded lists. */
export function findSession(id: string): SessionRow | undefined {
  for (const rows of Object.values(state.sessions)) {
    const hit = rows.find(r => r.id === id || r.resumeId === id)
    if (hit) return hit
  }
  return undefined
}

/** Open a session referenced from a message (`conduit://session/<id>?profile=…`, `@session:<id>`). Works for
 *  sessions hidden from the list too (worker / routine runs): resume takes any id the gateway knows. */
export function openSessionRef(id: string, profile?: string, fromBotId?: string, title = '') {
  const bot = state.bots[fromBotId ?? '']
  if (bot?.canonical && (bot.canonical.id === id || bot.canonical.resumeId === id)) return openBot(bot.id)
  const known = findSession(id)
  if (known) return openSession(known)
  const botId = botForProfile(profile, fromBotId)
  if (!botId) return
  openSession({
    key: threadKey(botId, id),
    botId,
    id,
    resumeId: id,
    title,
    source: '',
    preview: '',
    lastReply: '',
    lastActive: 0,
    messageCount: 0,
    running: false,
    pinned: false
  })
}

export function newChat(botId?: string) {
  const id = botId ?? prefs.lastBot ?? state.config?.bots[0]?.id
  if (!id) return
  savePrefs({ lastBot: id })
  const key = `${id}:new`
  set(s => {
    const threads = { ...s.threads }
    delete threads[key]
    return { view: { kind: 'new', botId: id }, threads }
  })
  ensureThread(key, { botId: id, loading: false })
}

export function setNewChatBot(botId: string) {
  newChat(botId)
}

// ─── sending ────────────────────────────────────────────────────────────────────────────────────

export async function send(text: string, drafts: Draft[] = []) {
  const v = state.view
  const key = focusedKey()
  if (!v || !key || (!text.trim() && !drafts.length)) return
  const botId = v.kind === 'session' ? state.threads[key]?.botId : v.botId
  if (!botId) return
  let t = state.threads[key]
  if (!t) return

  const images = drafts.filter(d => d.kind === 'image')
  const files = drafts.filter(d => d.kind === 'file')
  const userItem: Item = {
    kind: 'user',
    id: nid(),
    text,
    ts: Date.now() / 1000,
    ...(images.length ? { images: images.map(d => d.dataUrl) } : {}),
    ...(files.length ? { files: files.map(d => d.name) } : {})
  }
  patchThread(key, th => ({ items: [...th.items, userItem], running: true, thinking: true, status: undefined, localTurn: true }))

  try {
    let liveId = t.liveId
    let finalKey = key
    if (!liveId) {
      // New chat (or a bot that has never had a Bot Chat): mint the session first.
      const pick = createParamsFor(t.model)
      const created = await hermes.request<any>(botId, 'session.create', pick.params)
      liveId = created.session_id as string
      await applyFastAfterCreate(botId, liveId, pick.fast)
      // Bot Mode finds a bot's forever-chat by this exact title.
      if (t.isBotChat) await hermes.request(botId, 'session.title', { session_id: liveId, title: 'Bot Chat' }).catch(() => undefined)
      const rootId = (created.stored_session_id || created.info?.stored_session_id || liveId) as string
      finalKey = threadKey(botId, rootId)
      t = state.threads[key]
      set(s => {
        const threads = { ...s.threads }
        delete threads[key]
        threads[finalKey] = { ...t, key: finalKey, rootId, liveId, isBotChat: t.isBotChat }
        return {
          threads,
          live: { ...s.live, [`${botId}:${liveId}`]: finalKey },
          view: t.isBotChat ? s.view : { kind: 'session', key: finalKey },
          seen: { ...s.seen, [finalKey]: Date.now() / 1000 }
        }
      })
    }
    // Images: stored on the gateway host over REST, then admitted with the turn as `attachments`
    // (canonical gateways own the composer queue). Other files: staged into the session workspace by
    // `file.attach`, which hands back an `@file:` ref the message carries.
    const [uploaded, refs] = await Promise.all([
      Promise.all(images.map(d => hermes.uploadImage(botId, d.dataUrl, d.name))),
      Promise.all(
        files.map(async d => {
          const r = await hermes.request<{ attached?: boolean; ref_text?: string; message?: string }>(botId, 'file.attach', {
            session_id: liveId,
            name: d.name,
            data_url: d.dataUrl
          })
          if (!r.attached || !r.ref_text) throw new Error(r.message || `Couldn't attach ${d.name}`)
          return r.ref_text
        })
      )
    ])
    const body = [refs.join('\n'), text].filter(s => s.trim()).join('\n\n')

    // submission_id is the gateway's idempotency key for this turn (required on canonical gateways).
    await hermes.request(botId, 'prompt.submit', {
      session_id: liveId,
      text: body,
      submission_id: crypto.randomUUID(),
      ...(uploaded.length ? { attachments: uploaded.map(u => ({ path: u.path, mime: u.mime })) } : {})
    })
    scheduleRefresh(botId, 1500)
  } catch (err) {
    const k = focusedKey() ?? key
    patchThread(k, th => ({
      running: false,
      thinking: false,
      items: [...th.items, { kind: 'note', id: nid(), tone: 'error', text: `Couldn't send: ${(err as Error).message}` }]
    }))
  }
}

/** Stop the running turn. The gateway only takes a Stop that names the turn's execution generation
 *  (anything else is refused as stale_generation), so send the one we know and, when it's stale (the
 *  turn started after our last event, or another client started it), read the current one and retry. */
export async function stop() {
  const key = focusedKey()
  const t = key ? state.threads[key] : null
  if (!t?.liveId) return
  const { botId, liveId } = t
  const interrupt = (generation: number) =>
    hermes.request<any>(botId, 'session.interrupt', { session_id: liveId, execution_generation: generation })
  try {
    try {
      await interrupt(knownGeneration(botId, liveId))
    } catch (err) {
      if (rpcReason(err) !== 'stale_generation') throw err
      const snap = await hermes.request<any>(botId, 'session.resume', { session_id: liveId })
      noteFence(botId, liveId, snap.revision, snap.execution_generation)
      if (!(snap.running ?? snap.info?.running)) {
        patchThread(key!, () => ({ running: false, thinking: false }))
        return
      }
      await interrupt(knownGeneration(botId, liveId))
    }
  } catch (err) {
    patchThread(key!, th => ({
      items: [...th.items, { kind: 'note', id: nid(), tone: 'error', text: `Couldn't stop: ${(err as Error).message}` }]
    }))
  }
}

const rpcReason = (err: unknown): string | undefined => {
  const d = (err as { data?: any })?.data
  return d?.reason ?? d?.data?.reason ?? ((err as Error)?.message === 'stale_generation' ? 'stale_generation' : undefined)
}

// ─── prompts (approvals / clarify) ──────────────────────────────────────────────────────────────

function addPrompt(p: Prompt) {
  set(s => ({ prompts: [...s.prompts.filter(x => x.key !== p.key), p] }))
}

function dropPrompt(match: (p: Prompt) => boolean) {
  set(s => ({ prompts: s.prompts.filter(p => !match(p)) }))
}

export async function answerPrompt(p: Prompt, answer: string | Record<string, string>) {
  dropPrompt(x => x.key === p.key)
  if (p.requestId && !p.promptId) {
    const result = p.kind === 'approval' ? { choice: answer } : { answers: answer }
    await hermes.respond(p.botId, p.requestId, result)
    return
  }
  const method = p.kind === 'approval' ? 'approval.respond' : 'clarify.respond'
  const field = p.kind === 'approval' ? 'choice' : 'answer'
  const value = typeof answer === 'string' ? answer : Object.values(answer)[0] ?? ''
  await hermes
    .request(p.botId, method, { session_id: p.sessionId, execution_generation: p.generation, prompt_id: p.promptId, [field]: value })
    .catch(err => console.warn('prompt answer failed', err))
}

function onServerRequest(r: ServerRequestEnvelope) {
  const sid = String(r.params.session_id ?? '')
  if (r.method === 'approval') {
    addPrompt({ key: `${r.botId}:${r.id}`, botId: r.botId, sessionId: sid, kind: 'approval', requestId: r.id, command: r.params.command, description: r.params.description, choices: r.params.choices })
  } else if (r.method === 'clarify') {
    addPrompt({ key: `${r.botId}:${r.id}`, botId: r.botId, sessionId: sid, kind: 'clarify', requestId: r.id, questions: r.params.questions })
  } else {
    // Secrets, sudo, vault, previews: not supported here; decline so the agent isn't stuck.
    void hermes.respond(r.botId, r.id, {})
  }
}

// ─── reply notifications ────────────────────────────────────────────────────────────────────────

/** Markdown to one plain line for a notification body. */
function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A reply finished while HermesChan is in the background: bounce the dock and post a notification
 *  (the main process skips both if the window has focus). Only for chats you'd see: a Bot Chat, a
 *  chat in the sidebar, or one open here; hidden routine and workstream runs stay quiet. */
function notifyReply(botId: string, sid: string, payload: Record<string, any>, key?: string) {
  if (state.windowFocused) return
  if (payload.status === 'interrupted' || payload.status === 'cancelled') return
  const bot = state.bots[botId]
  if (!bot) return
  const canonical = !!bot.canonical && (bot.canonical.id === sid || bot.canonical.resumeId === sid)
  const row = findSession(sid)
  const hidden = state.config?.hiddenSources ?? []
  if (!key && !canonical && (!row || isRoutine(row, hidden))) return
  const err = payload.error || (payload.status === 'error' ? payload.failure_reason : null)
  const text = err ? `Couldn't finish: ${err}` : plainText(typeof payload.text === 'string' ? payload.text : '')
  const thread = key ? state.threads[key] : undefined
  const isBotChat = canonical || !!thread?.isBotChat
  const body = text.length > 180 ? `${text.slice(0, 177)}…` : text || 'New message'
  hermes.notify({ botId, sessionId: sid, title: bot.name, subtitle: isBotChat ? undefined : thread?.title || row?.title || undefined, body })
}

function openFromNotice({ botId, sessionId }: { botId: string; sessionId: string }) {
  const bot = state.bots[botId]
  if (bot?.canonical && (bot.canonical.id === sessionId || bot.canonical.resumeId === sessionId)) return openBot(botId)
  const key = state.live[`${botId}:${sessionId}`]
  if (key && state.threads[key]?.isBotChat) return openBot(botId)
  if (key && state.threads[key]) return set({ view: { kind: 'session', key } })
  openSessionRef(sessionId, undefined, botId)
}

// ─── streaming events ───────────────────────────────────────────────────────────────────────────

function lastStreaming(t: Thread) {
  const last = t.items[t.items.length - 1]
  return last?.kind === 'assistant' && last.streaming ? last : null
}

function closeStreaming(items: Item[]): Item[] {
  return items.map(i => (i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i))
}

function onEvent({ botId, event }: GatewayEventEnvelope) {
  const { type, payload = {} } = event
  if (type === 'sessions.changed' || type === 'gateway.ready') {
    scheduleRefresh(botId, type === 'gateway.ready' ? 50 : 600)
    return
  }

  const sid = event.session_id
  if (type === 'approval.request' || type === 'clarify.request') {
    addPrompt({
      key: `${botId}:${payload.prompt_id}`,
      botId,
      sessionId: sid ?? '',
      kind: type === 'approval.request' ? 'approval' : 'clarify',
      promptId: payload.prompt_id,
      generation: payload.execution_generation,
      command: payload.command,
      description: payload.description,
      question: payload.question,
      choices: payload.choices
    })
    return
  }
  if (type === 'approval.settled' || type === 'clarify.settled') {
    dropPrompt(p => p.botId === botId && p.promptId === payload.prompt_id)
    return
  }
  if (type === 'request.cancel') {
    dropPrompt(p => p.botId === botId && p.requestId === payload.id)
    return
  }

  if (!sid) return
  noteFence(botId, sid, payload?.revision, (event as { execution_generation?: number }).execution_generation)
  const key = state.live[`${botId}:${sid}`]
  if (!key) {
    if (type === 'message.complete') {
      notifyReply(botId, sid, payload)
      scheduleRefresh(botId)
    }
    return
  }

  switch (type) {
    case 'message.start': {
      // Turns we didn't start here (cron reports, another device or client) re-sync from the stored
      // transcript when they finish, so they get the same presentation as history.
      patchThread(key, () => ({ running: true, thinking: true }))
      break
    }
    case 'message.delta': {
      const chunk = typeof payload.text === 'string' ? payload.text : ''
      if (!chunk) break
      patchThread(key, t => {
        const cur = lastStreaming(t)
        if (cur) {
          return { thinking: false, running: true, items: [...t.items.slice(0, -1), { ...cur, text: cur.text + chunk }] }
        }
        return { thinking: false, running: true, items: [...t.items, { kind: 'assistant', id: nid(), text: chunk, streaming: true, ts: Date.now() / 1000 }] }
      })
      break
    }
    case 'thinking.delta':
    case 'reasoning.delta':
      patchThread(key, t => (t.thinking ? {} : { thinking: !lastStreaming(t) }))
      break
    case 'status.update':
      if (payload.text) patchThread(key, () => ({ status: String(payload.text) }))
      break
    case 'tool.start':
    case 'tool.generating': {
      const id = payload.tool_id
      patchThread(key, t => {
        if (id && t.items.some(i => i.kind === 'tool' && i.tool.toolId === id)) return {}
        const label = Array.isArray(payload.labels) && payload.labels[0]
        const tool: ToolInfo = {
          toolId: id,
          name: payload.name,
          label: label?.text || payload.context || prettyTool(payload.name),
          emoji: label?.emoji,
          preview: label?.preview || payload.preview || undefined,
          done: false
        }
        return { thinking: true, items: [...closeStreaming(t.items), { kind: 'tool', id: nid(), tool, ts: Date.now() / 1000 }] }
      })
      break
    }
    case 'tool.complete': {
      patchThread(key, t => ({
        items: t.items.map(i =>
          i.kind === 'tool' && i.tool.toolId === payload.tool_id ? { ...i, tool: { ...i.tool, done: true, duration: payload.duration_s ?? undefined } } : i
        )
      }))
      break
    }
    case 'message.complete': {
      const finalText = typeof payload.text === 'string' ? payload.text : ''
      patchThread(key, t => {
        let items = t.items
        const cur = lastStreaming(t)
        if (cur && finalText) items = [...items.slice(0, -1), { ...cur, text: finalText }]
        else if (!cur && finalText.trim()) {
          const lastUser = [...items].reverse().findIndex(i => i.kind === 'user')
          const tail = lastUser === -1 ? items : items.slice(items.length - lastUser)
          const already = tail.some(i => i.kind === 'assistant' && i.text === finalText)
          if (!already) items = [...items, { kind: 'assistant', id: nid(), text: finalText, ts: Date.now() / 1000 }]
        }
        items = closeStreaming(items).map(i => (i.kind === 'tool' && !i.tool.done ? { ...i, tool: { ...i.tool, done: true } } : i))
        const err = payload.error || (payload.status === 'error' ? payload.failure_reason : null)
        if (err) items = [...items, { kind: 'note', id: nid(), tone: 'error', text: String(err) }]
        return { items, running: false, thinking: false, status: undefined }
      })
      notifyReply(botId, sid, payload, key)
      const done = state.threads[key]
      if (done && !done.localTurn && done.liveId) void attach(key, botId, done.liveId)
      patchThread(key, () => ({ localTurn: false }))
      if (state.windowFocused && focusedKey() === key) markSeen(key)
      scheduleRefresh(botId, 800)
      break
    }
    case 'session.info':
      applyInfo(key, payload, { trustFast: false })
      break
    case 'session.title':
      if (payload.title) patchThread(key, () => ({ title: String(payload.title) }))
      scheduleRefresh(botId)
      break
    case 'session.replay_gap': {
      const t = state.threads[key]
      if (t?.liveId) void attach(key, botId, t.liveId)
      break
    }
    case 'error':
      patchThread(key, t => ({ running: false, thinking: false, items: [...t.items, { kind: 'note', id: nid(), tone: 'error', text: String(payload.message ?? 'Something went wrong') }] }))
      break
  }
}

// ─── misc actions ───────────────────────────────────────────────────────────────────────────────

export const setSearch = (search: string) => set({ search })

function patchRow(key: string, patch: Partial<SessionRow>) {
  set(s => {
    const sessions: State['sessions'] = {}
    for (const [bot, rows] of Object.entries(s.sessions)) sessions[bot] = rows.map(r => (r.key === key ? { ...r, ...patch } : r))
    return { sessions }
  })
}

/** Pin or unpin a chat (stored on the session in Hermes, so it syncs). `at` places a new pin. */
export async function setPinned(row: SessionRow, pinned: boolean, at?: number) {
  if (row.pinned === pinned && at === undefined) return
  patchRow(row.key, { pinned })
  if (pinned) {
    const order = state.pinOrder.filter(k => k !== row.key)
    order.splice(at ?? 0, 0, row.key)
    set({ pinOrder: order })
  } else {
    set(s => ({ pinOrder: s.pinOrder.filter(k => k !== row.key) }))
  }
  if (row.pinned === pinned) return
  try {
    await fencedMutate(row.botId, row.resumeId, 'sidebar', { pinned })
  } catch (err) {
    patchRow(row.key, { pinned: !pinned })
    console.warn('pin failed', err)
  }
}

/** Move a pinned chat to `index` within the pinned list (drag to reorder). */
export function movePinned(key: string, index: number) {
  const current = pinnedSessions().map(r => r.key)
  const from = current.indexOf(key)
  if (from < 0) return
  current.splice(from, 1)
  current.splice(Math.max(0, Math.min(index, current.length)), 0, key)
  // Keep slots for pins not currently listed (other bot offline, search filter) after the visible ones.
  set(s => ({ pinOrder: [...current, ...s.pinOrder.filter(k => !current.includes(k))] }))
}

export const openSetup = () => set({ setupOpen: true })
export const closeSetup = () => set({ setupOpen: false })

/** Rebuild a bot's connection from scratch (all offline bots when no id). */
export function reconnectBot(botId?: string) {
  if (botId) set(s => ({ statuses: { ...s.statuses, [botId]: { botId, state: 'connecting', detail: 'Reconnecting…' } } }))
  return hermes.reconnect(botId).catch(err => console.warn('reconnect failed', err))
}

export function toggleRoutine() {
  savePrefs({ showRoutine: !state.showRoutine })
  set(s => ({ showRoutine: !s.showRoutine }))
}

export const lastBotId = () => prefs.lastBot

// ─── boot ───────────────────────────────────────────────────────────────────────────────────────

export async function boot() {
  const config = await hermes.config()
  const statuses = Object.fromEntries((await hermes.statuses()).map(s => [s.botId, s]))
  const bots: Record<string, Bot> = {}
  for (const b of config.bots) {
    bots[b.id] = { id: b.id, name: b.name ?? b.transport.profile, color: b.color ?? 'hsl(45 90% 60%)' }
  }
  set({ config, statuses, bots })

  hermes.onEvent(onEvent)
  hermes.onOpenChat(openFromNotice)
  hermes.onRequest(onServerRequest)
  hermes.onStatus(st => {
    const was = state.statuses[st.botId]?.state
    set(s => ({ statuses: { ...s.statuses, [st.botId]: st } }))
    if (st.state === 'ready') {
      scheduleRefresh(st.botId, 50)
      // Back after a drop: a new socket has no session subscriptions, so re-open this bot's loaded
      // chats to get live replies (and anything that arrived while offline).
      if (was && was !== 'ready') {
        for (const t of Object.values(state.threads)) {
          if (t.botId === st.botId && t.liveId) void attach(t.key, t.botId, t.liveId)
        }
      }
    }
  })

  // The network came back: retry anything offline right away instead of waiting on backoff.
  window.addEventListener('online', () => void hermes.reconnect().catch(() => undefined))

  for (const b of config.bots) if (statuses[b.id]?.state === 'ready') scheduleRefresh(b.id, 50)
  setInterval(() => config.bots.forEach(b => scheduleRefresh(b.id, 0)), 45_000)

  window.addEventListener('focus', () => {
    set({ windowFocused: true })
    const k = focusedKey()
    if (k) markSeen(k)
  })
  window.addEventListener('blur', () => set({ windowFocused: false }))

  const first = prefs.lastBot && config.bots.some(b => b.id === prefs.lastBot) ? prefs.lastBot : config.bots[0]?.id
  if (first) {
    set({ view: { kind: 'bot', botId: first } })
    // Open once the bot's canonical chat is known.
    const tryOpen = () => {
      if (state.view?.kind === 'bot' && state.view.botId === first && state.bots[first]?.canonical) {
        openBot(first)
        return true
      }
      return false
    }
    if (!tryOpen()) {
      const unsub = (() => {
        const l = () => {
          if (state.bots[first]?.canonical || state.statuses[first]?.state === 'error') {
            listeners.delete(l)
            if (state.view?.kind === 'bot' && state.view.botId === first) openBot(first)
          }
        }
        listeners.add(l)
        return () => listeners.delete(l)
      })()
      setTimeout(unsub, 60_000)
    }
  }
}

// ─── workstreams ───────────────────────────────────────────────────────────────────────────────

const ACTIVE_WORK = ['starting', 'running', 'needs_you', 'waiting', 'ready']
export const isActiveWork = (w: Workstream) => ACTIVE_WORK.includes(w.status)

/** Refresh a bot's workstreams. A bot without the Conduit plugin just gets an empty list; a failed
 *  read keeps whatever was shown before. */
export async function loadWorkstreams(botId: string) {
  try {
    const list = await hermes.workstreams(botId)
    set(s => ({ workstreams: { ...s.workstreams, [botId]: list } }))
  } catch {
    /* offline or unreadable: keep the last list */
  }
}

export function toggleWorkstreams(open = !state.showWorkstreams) {
  savePrefs({ showWorkstreams: open })
  set({ showWorkstreams: open })
}
