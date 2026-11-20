/** A bot's settings, opened from its tile's right-click menu: its name, description and colour, its
 *  soul (SOUL.md), and which skills, toolsets and MCP servers it can use. Reads and saves go through
 *  the gateway's profile editor (`profiles.describe` / `profiles.configure`), the same calls the
 *  Hermes desktop app's editor makes, so this works for bots on other machines too. */
import { useEffect, useMemo, useRef, useState } from 'react'

import { Avatar } from './Avatar'
import { hermes } from './bridge'
import { closeBotSettings, openBotSettings, scheduleRefresh, useStore, type BotSettingsTab } from './store'

interface Toolset {
  name: string
  label: string
  description: string
  tools: number
  enabled: boolean
}

interface Draft {
  title: string
  description: string
  color: string
  soul: string
  skills: { name: string; enabled: boolean }[]
  toolsets: Toolset[]
  mcp: { name: string; transport: string; enabled: boolean }[]
}

interface Loaded extends Draft {
  profile: string
  /** The rest of the bot's `hermes-bots` metadata, kept as is when we write ours. */
  meta: Record<string, unknown>
  metaRevision: number
}

const TABS: { id: BotSettingsTab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'soul', label: 'Soul' },
  { id: 'skills', label: 'Skills' },
  { id: 'tools', label: 'Tools' }
]

const COLORS = [
  'hsl(45 92% 62%)',
  'hsl(18 85% 64%)',
  'hsl(350 75% 66%)',
  'hsl(330 80% 70%)',
  'hsl(268 70% 72%)',
  'hsl(215 85% 66%)',
  'hsl(190 70% 52%)',
  'hsl(158 55% 52%)',
  'hsl(95 45% 55%)',
  'hsl(30 10% 62%)'
]

async function load(botId: string, profile: string): Promise<Loaded> {
  const [d, list] = await Promise.all([
    hermes.request<any>(botId, 'profiles.describe', { name: profile }),
    hermes.request<{ profiles: any[] }>(botId, 'profiles.list', {})
  ])
  const p = list.profiles.find(x => x.name === profile) ?? list.profiles.find(x => x.is_default)
  const meta = (p?.ui_meta?.['hermes-bots'] ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    profile,
    meta,
    metaRevision: Number(p?.ui_meta_revisions?.['hermes-bots'] ?? 0),
    title: str(meta.title) || str(p?.display_name) || profile,
    description: str(meta.description) || str(d.description),
    color: str(meta.color),
    soul: str(d.soul),
    skills: (d.skills ?? []).map((s: any) => ({ name: String(s.name), enabled: s.enabled !== false })),
    toolsets: (d.toolsets ?? []).map((t: any) => ({
      name: String(t.name),
      label: str(t.label) || String(t.name),
      description: str(t.description),
      tools: Number(t.tool_count ?? 0),
      enabled: t.enabled !== false
    })),
    mcp: (d.mcp_servers ?? []).map((m: any) => ({ name: String(m.name), transport: str(m.transport) || 'stdio', enabled: m.enabled !== false }))
  }
}

const same = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b)

/** What changed, per section: the Save button sends only these. */
function changes(base: Loaded, d: Draft) {
  return {
    profile: base.title !== d.title || base.description !== d.description || base.color !== d.color,
    soul: base.soul !== d.soul,
    skills: !same(base.skills, d.skills),
    toolsets: !same(base.toolsets, d.toolsets),
    mcp: !same(base.mcp, d.mcp)
  }
}

export function BotSettings() {
  const open = useStore(s => s.botSettings)
  const bot = useStore(s => (open ? s.bots[open.botId] : undefined))
  const cfg = useStore(s => (open ? s.config?.bots.find(b => b.id === open.botId) : undefined))
  const online = useStore(s => !!open && s.statuses[open.botId]?.state === 'ready')
  const [base, setBase] = useState<Loaded | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const botId = open?.botId ?? ''
  const profile = cfg?.transport.profile ?? 'default'

  const reload = async () => {
    setError(null)
    try {
      const l = await load(botId, profile)
      setBase(l)
      setDraft(l)
    } catch (err) {
      setError(friendly(err))
    }
  }

  useEffect(() => {
    setBase(null)
    setDraft(null)
    setSaved(false)
    if (botId && online) void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, online])

  const dirty = base && draft ? changes(base, draft) : null
  const anyDirty = !!dirty && Object.values(dirty).some(Boolean)

  const close = () => {
    if (anyDirty && !window.confirm('Discard your unsaved changes?')) return
    closeBotSettings()
  }

  const save = async () => {
    if (!base || !draft || !dirty || !anyDirty || saving) return
    setSaving(true)
    setError(null)
    const params: Record<string, unknown> = { name: base.profile }
    if (dirty.profile) {
      params.ui_meta = { 'hermes-bots': { ...base.meta, title: draft.title.trim() || base.profile, description: draft.description.trim(), color: draft.color || undefined } }
      params.ui_meta_expected_revisions = { 'hermes-bots': base.metaRevision }
      params.description = draft.description.trim()
    }
    if (dirty.soul) params.soul = draft.soul
    if (dirty.skills) params.disabled_skills = draft.skills.filter(s => !s.enabled).map(s => s.name)
    if (dirty.toolsets) params.enabled_toolsets = draft.toolsets.filter(t => t.enabled).map(t => t.name)
    if (dirty.mcp) params.enabled_mcp_servers = draft.mcp.filter(m => m.enabled).map(m => m.name)
    try {
      const r = await hermes.request<any>(botId, 'profiles.configure', params)
      const applied = (r?.applied ?? {}) as Record<string, unknown>
      if (applied.ui_meta_conflicts) throw new Error('This bot’s profile was changed somewhere else. Reload to see the latest, then make your change again.')
      const failed = Object.entries(applied).filter(([k, v]) => v === false && !k.startsWith('ui_meta_'))
      if (failed.length) throw new Error(`Couldn’t save ${failed.map(([k]) => SECTION[k] ?? k).join(', ')}.`)
      await reload()
      scheduleRefresh(botId, 0)
      setSaved(true)
    } catch (err) {
      setError(friendly(err))
    } finally {
      setSaving(false)
    }
  }

  // ⌘S saves, Esc closes (asking first when there are unsaved changes).
  const saveRef = useRef(save)
  saveRef.current = save
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 's' && e.metaKey) {
        e.preventDefault()
        void saveRef.current()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!open || !bot) return null
  const tab = open.tab
  const set = (patch: Partial<Draft>) => {
    setSaved(false)
    setDraft(d => (d ? { ...d, ...patch } : d))
  }

  return (
    <div className="bs-overlay" onMouseDown={e => e.target === e.currentTarget && close()}>
      <div className="bs-sheet" role="dialog" aria-label={`${bot.name} settings`} style={{ ['--bot' as string]: draft?.color || bot.color }}>
        <nav className="bs-nav">
          <div className="bs-who">
            <Avatar bot={{ ...bot, color: draft?.color || bot.color }} size={40} />
            <div>
              <div className="bs-name">{draft?.title || bot.name}</div>
              <div className="bs-profile">{cfg?.transport.kind === 'ssh' ? `${profile} on ${cfg.transport.host}` : `${profile} on this Mac`}</div>
            </div>
          </div>
          {TABS.map(t => (
            <button key={t.id} className={`bs-tab ${tab === t.id ? 'on' : ''}`} onClick={() => openBotSettings(botId, t.id)}>
              {t.label}
              {dirty && tabDirty(t.id, dirty) && <span className="bs-dot" title="Unsaved changes" />}
            </button>
          ))}
        </nav>

        <section className="bs-main">
          <header className="bs-head">
            <h2>{TABS.find(t => t.id === tab)?.label}</h2>
            <button className="kb-close" onClick={close} title="Close (Esc)" aria-label="Close settings">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </header>

          <div className={`bs-body ${tab === 'soul' ? 'fill' : ''}`}>
            {!online ? (
              <p className="bs-state">{bot.name} is offline. Settings load once it reconnects.</p>
            ) : !draft ? (
              error ? (
                <p className="bs-state bad">{error}</p>
              ) : (
                <p className="bs-state">Loading…</p>
              )
            ) : tab === 'profile' ? (
              <ProfileTab draft={draft} set={set} />
            ) : tab === 'soul' ? (
              <SoulTab soul={draft.soul} onChange={soul => set({ soul })} />
            ) : tab === 'skills' ? (
              <SkillsTab skills={draft.skills} onChange={skills => set({ skills })} />
            ) : (
              <ToolsTab toolsets={draft.toolsets} mcp={draft.mcp} onChange={set} />
            )}
          </div>

          <footer className="bs-foot">
            <span className={`bs-status ${error && draft ? 'bad' : ''}`}>
              {error && draft ? error : saved && !anyDirty ? 'Saved. New chats use the changes.' : anyDirty ? 'Unsaved changes' : ' '}
            </span>
            <button className="kb-btn" disabled={!anyDirty || saving} onClick={() => base && (setDraft(base), setError(null))}>
              Revert
            </button>
            <button className="kb-btn primary" disabled={!anyDirty || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </footer>
        </section>
      </div>
    </div>
  )
}

const SECTION: Record<string, string> = { soul: 'the soul', description: 'the description', ui_meta: 'the name and colour', skills: 'skills', toolsets: 'toolsets', mcp_servers: 'MCP servers' }

function tabDirty(tab: BotSettingsTab, d: ReturnType<typeof changes>) {
  if (tab === 'profile') return d.profile
  if (tab === 'soul') return d.soul
  if (tab === 'skills') return d.skills
  return d.toolsets || d.mcp
}

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  try {
    const parsed = JSON.parse(msg)
    if (parsed?.message) return String(parsed.message)
  } catch {
    /* plain message */
  }
  return msg
}

function ProfileTab({ draft, set }: { draft: Draft; set: (p: Partial<Draft>) => void }) {
  return (
    <div className="bs-form">
      <label className="bs-field">
        <span>Name</span>
        <input value={draft.title} onChange={e => set({ title: e.target.value })} maxLength={60} />
      </label>
      <label className="bs-field">
        <span>Description</span>
        <textarea value={draft.description} onChange={e => set({ description: e.target.value })} rows={3} placeholder="What this bot is for. Hermes also uses it when routing work between bots." />
      </label>
      <div className="bs-field">
        <span>Colour</span>
        <div className="bs-swatches">
          {[...new Set([...(draft.color && !COLORS.includes(draft.color) ? [draft.color] : []), ...COLORS])].map(c => (
            <button key={c} className={`bs-swatch ${draft.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set({ color: c })} aria-label={`Colour ${c}`} aria-pressed={draft.color === c} />
          ))}
        </div>
      </div>
    </div>
  )
}

function SoulTab({ soul, onChange }: { soul: string; onChange: (s: string) => void }) {
  const lines = soul ? soul.split('\n').length : 0
  return (
    <div className="bs-soul">
      <p className="bs-hint">
        <code>SOUL.md</code> is the bot’s personality and standing instructions, read at the start of every chat. New chats use your changes; chats already open keep the version they started with.
      </p>
      <textarea value={soul} onChange={e => onChange(e.target.value)} spellCheck={false} placeholder="You are…" aria-label="SOUL.md" />
      <div className="bs-soul-meta">
        {lines} line{lines === 1 ? '' : 's'} · {soul.length.toLocaleString()} characters · ⌘S to save
      </div>
    </div>
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className={`bs-toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />
}

function SkillsTab({ skills, onChange }: { skills: Draft['skills']; onChange: (s: Draft['skills']) => void }) {
  const [q, setQ] = useState('')
  const shown = useMemo(() => skills.filter(s => !q || s.name.toLowerCase().includes(q.toLowerCase())), [skills, q])
  const off = skills.filter(s => !s.enabled).length
  return (
    <div className="bs-list-wrap">
      <div className="bs-list-tools">
        <label className="kanban-filter">
          <span aria-hidden>⌕</span>
          <input placeholder="Filter skills" value={q} onChange={e => setQ(e.target.value)} />
        </label>
        <span className="bs-count">
          {skills.length - off} of {skills.length} on
        </span>
      </div>
      <ul className="bs-list">
        {shown.map(s => (
          <li key={s.name}>
            <span className="bs-item-name">{s.name}</span>
            <Toggle on={s.enabled} label={s.name} onChange={v => onChange(skills.map(x => (x.name === s.name ? { ...x, enabled: v } : x)))} />
          </li>
        ))}
        {!shown.length && <li className="bs-empty">No skills match.</li>}
      </ul>
    </div>
  )
}

function ToolsTab({ toolsets, mcp, onChange }: { toolsets: Toolset[]; mcp: Draft['mcp']; onChange: (p: Partial<Draft>) => void }) {
  return (
    <div className="bs-list-wrap">
      <h3 className="bs-sub">Toolsets</h3>
      <ul className="bs-list">
        {toolsets.map(t => (
          <li key={t.name}>
            <span className="bs-item">
              <span className="bs-item-name">
                {t.label}
                {t.tools > 0 && <span className="bs-item-count">{t.tools} tools</span>}
              </span>
              {t.description && <span className="bs-item-desc">{t.description}</span>}
            </span>
            <Toggle on={t.enabled} label={t.label} onChange={v => onChange({ toolsets: toolsets.map(x => (x.name === t.name ? { ...x, enabled: v } : x)) })} />
          </li>
        ))}
      </ul>
      {mcp.length > 0 && (
        <>
          <h3 className="bs-sub">MCP servers</h3>
          <ul className="bs-list">
            {mcp.map(m => (
              <li key={m.name}>
                <span className="bs-item">
                  <span className="bs-item-name">
                    {m.name}
                    <span className="bs-item-count">{m.transport}</span>
                  </span>
                </span>
                <Toggle on={m.enabled} label={m.name} onChange={v => onChange({ mcp: mcp.map(x => (x.name === m.name ? { ...x, enabled: v } : x)) })} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
