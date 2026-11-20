/** Slash commands: the bot's command catalog for the composer's menu, and which commands HermesChan
 *  can run. The catalog comes from the gateway (`commands.catalog`, the same list the Hermes desktop
 *  app and TUI show); each entry says where it works (`desktop`: null = anywhere, 'terminal' = the
 *  TUI only, …) and whether it takes an argument. */
import { hermes } from './bridge'

export type ArgMode = 'text' | 'options' | 'mixed' | null

export interface SlashCommand {
  /** With its slash, e.g. `/status`. */
  name: string
  desc: string
  kind: 'command' | 'skill'
  args: ArgMode
  /** Shown in the menu. False for aliases and for commands HermesChan has no surface for. */
  offered: boolean
  /** Why it can't run here, when it can't. */
  unavailable?: string
  /** Section in the menu ("Session", "Info", "Skills", …). */
  group: string
  /** For an alias, the command it stands for. */
  aliasOf?: string
}

export interface Catalog {
  /** Every name the bot knows, aliases included, keyed by `/name`. */
  byName: Map<string, SlashCommand>
  /** What the menu offers, in catalog order. */
  offered: SlashCommand[]
}

/** Commands the desktop app answers with its own UI (pickers, sidebars, profile switches) that have
 *  no counterpart here. Running them through the gateway's slash worker would act on a side copy of
 *  the session or open a terminal prompt nobody can see, so they stay out of the menu. */
const NO_SURFACE = new Set([
  '/resume', '/sessions', '/switch', '/profile', '/skin', '/palette', '/pet', '/pets', '/hatch', '/generate-pet',
  '/browser', '/export', '/import', '/handoff', '/branch', '/fork', '/journey', '/model', '/login', '/wake',
  '/voice', '/config', '/prompt', '/compose', '/history', '/density', '/details', '/logs', '/mouse'
])

/** Run in this window instead of on the gateway. */
export const CLIENT_COMMANDS = new Set(['/new', '/reset'])

/** Descriptions that read differently here than in the terminal. */
const OUR_DESC: Record<string, string> = {
  '/new': 'Start a new chat',
  '/stop': 'Stop the current reply and any background processes'
}

const UNAVAILABLE: Record<string, string> = {
  terminal: 'only works in the Hermes terminal app',
  settings: 'is in the Hermes desktop app’s settings',
  advanced: 'is only in the Hermes desktop app',
  'composer-voice': 'is only in the Hermes desktop app',
  messaging: 'only works in messaging platforms',
  hidden: 'isn’t available in HermesChan'
}

const cache = new Map<string, { at: number; p: Promise<Catalog> }>()
const TTL = 5 * 60_000
/** A request to a bot that just dropped can hang; give up rather than block the menu until the TTL. */
const TIMEOUT = 10_000

/** The bot's catalog, fetched once and refreshed every few minutes (skills come and go). A failed or
 *  timed-out fetch is forgotten, so the next `/` asks again. */
export function loadCatalog(botId: string): Promise<Catalog> {
  const hit = cache.get(botId)
  if (hit && Date.now() - hit.at < TTL) return hit.p
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('commands.catalog timed out')), TIMEOUT)
  })
  const p = Promise.race([hermes.request<any>(botId, 'commands.catalog', {}).then(buildCatalog), timeout]).finally(() => clearTimeout(timer))
  const entry = { at: Date.now(), p }
  p.then(c => ready.set(botId, c)).catch(() => {
    if (cache.get(botId) === entry) cache.delete(botId)
  })
  cache.set(botId, entry)
  return p
}

/** Drop what we know about a bot's commands (it reconnected: its gateway may have restarted). */
export function forgetCatalog(botId: string) {
  cache.delete(botId)
}

/** The catalog if it's already loaded, for synchronous checks while typing. */
const ready = new Map<string, Catalog>()
export const catalogNow = (botId: string) => ready.get(botId)
export function warmCatalog(botId: string) {
  void loadCatalog(botId)
    .then(c => ready.set(botId, c))
    .catch(() => undefined)
}

function buildCatalog(raw: any): Catalog {
  const meta: Record<string, { argument_mode?: ArgMode; desktop?: string | null }> = raw?.commands ?? {}
  const skills: Record<string, unknown> = raw?.skills ?? {}
  const canon: Record<string, string> = raw?.canon ?? {}
  const byName = new Map<string, SlashCommand>()
  const offered: SlashCommand[] = []

  const make = (name: string, desc: string, group: string): SlashCommand => {
    const m = meta[name] ?? meta[canon[name] ?? ''] ?? {}
    const kind = skills[name] ? 'skill' : 'command'
    const surface = m.desktop ?? null
    const unavailable =
      surface && surface !== 'hidden' ? UNAVAILABLE[surface] ?? 'isn’t available in HermesChan' : NO_SURFACE.has(canon[name] ?? name) ? UNAVAILABLE.hidden : undefined
    return { name, desc: OUR_DESC[name] ?? cleanDesc(desc), kind, args: m.argument_mode ?? null, offered: !unavailable && surface !== 'hidden', unavailable, group }
  }

  const sections: { name: string; pairs: [string, string][] }[] = raw?.categories?.length ? raw.categories : [{ name: '', pairs: raw?.pairs ?? [] }]
  for (const section of sections) {
    for (const [name, desc] of section.pairs) {
      if (byName.has(name)) continue
      const group = skills[name] ? 'Skills' : section.name || 'Commands'
      const c = make(name, desc, group)
      byName.set(name, c)
      if (c.offered) offered.push(c)
    }
  }
  // Skills and quick commands the categories left out.
  for (const [name, desc] of (raw?.pairs ?? []) as [string, string][]) {
    if (byName.has(name)) continue
    const c = make(name, desc, skills[name] ? 'Skills' : 'Commands')
    byName.set(name, c)
    if (c.offered) offered.push(c)
  }
  // Aliases (`/reset` → `/new`): recognised when typed, not listed.
  for (const [alias, target] of Object.entries(canon)) {
    if (byName.has(alias)) continue
    const t = byName.get(target)
    if (t) byName.set(alias, { ...t, name: alias, offered: false, aliasOf: target })
  }
  // Skills sit after the built-in sections.
  offered.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'skill' ? 1 : -1))
  return { byName, offered }
}

/** "Switch model (usage: /model …)" → the description, with the usage kept separately. */
function cleanDesc(desc: string) {
  return desc.replace(/\s*\(usage: [^)]*\)\s*$/, '').trim()
}

/** Commands matching what's typed after the slash: name prefix first, then name substring, then
 *  (from four letters on) a word in the description that starts with it. */
export function matchCommands(cat: Catalog, query: string, limit = 60): SlashCommand[] {
  const q = query.toLowerCase()
  if (!q) return cat.offered.slice(0, limit)
  const prefix: SlashCommand[] = []
  const inner: SlashCommand[] = []
  const described: SlashCommand[] = []
  for (const c of cat.offered) {
    const n = c.name.slice(1).toLowerCase()
    if (n.startsWith(q)) prefix.push(c)
    else if (n.includes(q)) inner.push(c)
    else if (q.length > 3 && new RegExp(`\\b${q.replace(/[^\w-]/g, '')}`).test(c.desc.toLowerCase())) described.push(c)
  }
  // An alias typed in full (`/reset`) still surfaces its command.
  const alias = cat.byName.get(`/${q}`)
  if (alias?.aliasOf) {
    const target = cat.offered.find(c => c.name === alias.aliasOf)
    if (target && !prefix.includes(target)) prefix.unshift(target)
  }
  return [...prefix, ...inner, ...described].slice(0, limit)
}

export interface ArgItem {
  /** Replaces the text from `from` on. */
  text: string
  display: string
  meta: string
}

/** Argument completions from the gateway (`/reasoning ` → low, medium, high…). */
export async function completeArgs(botId: string, text: string, sessionId?: string): Promise<{ from: number; items: ArgItem[] }> {
  const r = await hermes.request<any>(botId, 'complete.slash', { text, ...(sessionId ? { session_id: sessionId } : {}) })
  const from = typeof r?.replace_from === 'number' ? r.replace_from : text.length
  const items: ArgItem[] = (r?.items ?? []).map((i: any) => ({
    text: String(i.text ?? ''),
    display: String(i.display ?? i.text ?? ''),
    meta: String(i.meta ?? '')
  }))
  return { from, items: items.filter(i => i.text) }
}

/** `/name rest` → its parts; null when the text isn't a command invocation. A path like `/usr/bin`
 *  isn't one. */
export function parseSlash(text: string): { name: string; arg: string } | null {
  const m = /^\/([a-zA-Z][\w-]*)(?![\w-]*\/)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? { name: `/${m[1].toLowerCase()}`, arg: (m[2] ?? '').trim() } : null
}
