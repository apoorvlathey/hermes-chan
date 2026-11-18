/** Model picker data and the session edits behind it.
 *
 *  - Inventory: `model.options` (signed-in providers only), cached per bot.
 *  - Current pick: `session.info` (model / provider / reasoning_effort / fast), kept on the thread.
 *  - Edits on canonical gateways: `session.mutate` operation `model` ({model, provider}) and `reasoning`
 *    ({effort}) — revision-fenced; a stale-fence refusal carries the fresh revision/generation, so we
 *    retry once. Fast mode is `config.set key=fast value=fast|normal`.
 *  - A chat that doesn't exist yet keeps the pick on the thread and `send` applies it at create. */
import { useSyncExternalStore } from 'react'

import { hermes } from './bridge'
import { getState, patchThreadPublic as patchThread } from './store'

export interface ModelPick {
  model: string
  provider: string
  effort?: string
  fast?: boolean
}

export interface ProviderModels {
  slug: string
  name: string
  current: boolean
  models: string[]
  caps: Record<string, { fast?: boolean; reasoning?: boolean; can_disable_reasoning?: boolean }>
}

interface ModelsState {
  /** Include providers you never set up yourself (ambient / auto-seeded credentials, e.g. Nous Portal). */
  showAll: boolean
  options: Record<string, { providers: ProviderModels[]; model: string; provider: string } | undefined>
  loading: Record<string, boolean>
  favorites: string[]
  presets: Record<string, { fast?: boolean; effort?: string }>
}

const SHOW_ALL_KEY = 'hermes-chan.models.showAll'
const readShowAll = () => {
  try {
    return localStorage.getItem(SHOW_ALL_KEY) === '1'
  } catch {
    return false
  }
}

let ms: ModelsState = { showAll: readShowAll(), options: {}, loading: {}, favorites: [], presets: {} }
const subs = new Set<() => void>()
const setMs = (p: Partial<ModelsState>) => {
  ms = { ...ms, ...p }
  subs.forEach(f => f())
}

export const useModels = () =>
  useSyncExternalStore(
    cb => {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    },
    () => ms
  )

export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

export const modelKey = (provider: string, model: string) => `${provider}::${model}`

let prefsLoaded = false
async function loadPrefs() {
  if (prefsLoaded) return
  prefsLoaded = true
  const p = await hermes.desktopModelPrefs().catch(() => ({ favorites: [], presets: {} }))
  setMs({ favorites: p.favorites ?? [], presets: p.presets ?? {} })
}

/** Fetch the bot's model inventory (refresh=true re-reads provider catalogues). */
export async function loadModelOptions(botId: string, sessionId?: string) {
  void loadPrefs()
  if (ms.loading[botId]) return
  setMs({ loading: { ...ms.loading, [botId]: true } })
  try {
    // explicit_only: only providers you configured yourself, not ones visible via ambient credentials.
    const r = await hermes.request<any>(botId, 'model.options', {
      ...(sessionId ? { session_id: sessionId } : {}),
      explicit_only: !ms.showAll
    })
    const providers: ProviderModels[] = (r.providers ?? [])
      .filter((p: any) => p.authenticated && p.models?.length)
      .map((p: any) => ({ slug: p.slug, name: p.name, current: !!p.is_current, models: p.models, caps: p.capabilities ?? {} }))
    setMs({ options: { ...ms.options, [botId]: { providers, model: r.model, provider: r.provider } } })
  } catch (err) {
    console.warn('model.options failed', err)
  } finally {
    setMs({ loading: { ...ms.loading, [botId]: false } })
  }
}

export function setShowAll(botId: string, showAll: boolean, sessionId?: string) {
  try {
    localStorage.setItem(SHOW_ALL_KEY, showAll ? '1' : '0')
  } catch {
    /* per-viewer convenience only */
  }
  setMs({ showAll, options: {} })
  void loadModelOptions(botId, sessionId)
}

export function capsFor(botId: string, provider: string, model: string) {
  return ms.options[botId]?.providers.find(p => p.slug === provider)?.caps[model] ?? {}
}

// ─── reading the current pick ───────────────────────────────────────────────────────────────────

export async function loadSessionModel(threadKey: string, botId: string, liveId: string) {
  try {
    const [info, fast] = await Promise.all([
      hermes.request<any>(botId, 'session.info', { session_id: liveId }),
      // session.info's `fast` is the launch policy; the live per-session tier answers to `status`.
      hermes.request<{ value?: string }>(botId, 'config.set', { session_id: liveId, key: 'fast', value: 'status' }).catch(() => null)
    ])
    applyInfo(threadKey, { ...info, fast: fast?.value ? fast.value !== 'normal' : undefined }, { trustFast: !!fast?.value })
  } catch {
    /* older gateway / transient: the header falls back to the bot's default */
  }
}

/** From `session.info` (RPC result or event payload). */
export function applyInfo(threadKey: string, info: any, opts: { trustFast?: boolean } = { trustFast: true }) {
  if (!info?.model) return
  patchThread(threadKey, t => ({
    model: {
      model: info.model,
      provider: info.provider || '',
      effort: info.reasoning_effort || undefined,
      // Only an explicit live read (config.set fast=status) is trusted; session.info's own `fast` is launch policy.
      fast: opts.trustFast && typeof info.fast === 'boolean' ? info.fast : t.model?.fast
    }
  }))
}

// ─── edits ──────────────────────────────────────────────────────────────────────────────────────

const fences = new Map<string, { revision: number; generation: number }>()

/** Remember fences seen on events/results for this live session. */
export function noteFence(botId: string, liveId: string, revision?: unknown, generation?: unknown) {
  const k = `${botId}:${liveId}`
  const cur = fences.get(k) ?? { revision: 0, generation: 0 }
  fences.set(k, {
    revision: typeof revision === 'number' && revision > cur.revision ? revision : cur.revision,
    generation: typeof generation === 'number' && generation > cur.generation ? generation : cur.generation
  })
}

/** The latest execution generation seen for this live session (0 when none yet). */
export const knownGeneration = (botId: string, liveId: string) => fences.get(`${botId}:${liveId}`)?.generation ?? 0

function freshFences(err: any): { revision?: number; generation?: number } {
  const d = err?.data ?? {}
  const src = d.data ?? d
  return {
    revision: typeof src.revision === 'number' ? src.revision : undefined,
    generation: typeof src.execution_generation === 'number' ? src.execution_generation : undefined
  }
}

/** Revision-fenced `session.mutate` (model, reasoning, sidebar pin, …). Works on stored sessions too:
 *  a stale-fence refusal carries the current revision/generation and we retry once with them. */
export async function fencedMutate(botId: string, sessionId: string, operation: string, payload: Record<string, unknown>) {
  return mutate(botId, sessionId, operation, payload)
}

async function mutate(botId: string, liveId: string, operation: string, payload: Record<string, unknown>) {
  const k = `${botId}:${liveId}`
  const send = () => {
    const f = fences.get(k) ?? { revision: 0, generation: 0 }
    return hermes.request<any>(botId, 'session.mutate', {
      session_id: liveId,
      request_id: crypto.randomUUID(),
      expected_revision: f.revision,
      expected_generation: f.generation,
      operation,
      payload
    })
  }
  try {
    const r = await send()
    noteFence(botId, liveId, r?.revision)
    return r
  } catch (err) {
    const fresh = freshFences(err)
    if (fresh.revision === undefined && fresh.generation === undefined) throw err
    noteFence(botId, liveId, fresh.revision, fresh.generation)
    const r = await send()
    noteFence(botId, liveId, r?.revision)
    return r
  }
}

const errText = (err: unknown) => {
  const e = err as { message?: string; data?: any }
  const reason = e?.data?.reason ?? e?.data?.data?.reason
  const friendly: Record<string, string> = {
    session_busy: 'Wait for the current reply to finish, then switch.',
    fast_unavailable: "Fast mode isn't available for this model.",
    confirm_required: 'This model needs confirmation (it may be expensive).'
  }
  return friendly[reason] ?? e?.message ?? 'Something went wrong'
}

/** Apply a pick to the focused thread: live session → mutate now; not created yet → keep for send. */
export async function applyPick(threadKey: string, change: Partial<ModelPick>): Promise<string | null> {
  const t = getState().threads[threadKey]
  if (!t) return null
  const prev = t.model
  const next: ModelPick = {
    model: change.model ?? prev?.model ?? '',
    provider: change.provider ?? prev?.provider ?? '',
    effort: 'effort' in change ? change.effort : prev?.effort,
    fast: 'fast' in change ? change.fast : prev?.fast
  }
  patchThread(threadKey, () => ({ model: next }))
  if (!t.liveId) return null

  try {
    if (change.model && (change.model !== prev?.model || change.provider !== prev?.provider)) {
      await mutate(t.botId, t.liveId, 'model', { model: next.model, provider: next.provider })
    }
    if ('effort' in change && change.effort && change.effort !== prev?.effort) {
      await mutate(t.botId, t.liveId, 'reasoning', { effort: change.effort })
    }
    if ('fast' in change && change.fast !== undefined && change.fast !== prev?.fast) {
      await hermes.request(t.botId, 'config.set', { session_id: t.liveId, key: 'fast', value: change.fast ? 'fast' : 'normal' })
    }
    void loadSessionModel(threadKey, t.botId, t.liveId)
    return null
  } catch (err) {
    patchThread(threadKey, () => ({ model: prev }))
    return errText(err)
  }
}

/** Picking a model also applies the user's Hermes Desktop preset for it (fast / effort), if any. */
export function presetFor(provider: string, model: string): { fast?: boolean; effort?: string } {
  return ms.presets[modelKey(provider, model)] ?? {}
}

/** What `session.create` should carry for a thread's pending pick, and the follow-up fast toggle. */
export function createParamsFor(pick: ModelPick | undefined): { params: Record<string, unknown>; fast?: boolean } {
  if (!pick?.model) return { params: {} }
  return {
    params: { model: pick.model, provider: pick.provider, ...(pick.effort ? { reasoning: pick.effort } : {}) },
    fast: pick.fast
  }
}

export async function applyFastAfterCreate(botId: string, liveId: string, fast?: boolean) {
  if (fast === undefined) return
  await hermes.request(botId, 'config.set', { session_id: liveId, key: 'fast', value: fast ? 'fast' : 'normal' }).catch(() => undefined)
}
