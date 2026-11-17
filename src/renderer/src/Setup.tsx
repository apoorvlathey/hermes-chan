/** Getting started / manage bots. Finds Hermes on this Mac and on SSH hosts, lists the profiles
 *  found there, and turns the ticked ones into bots. Saving rewrites ~/.hermes-chan/config.json and
 *  the app reconnects and repaints. */
import { useEffect, useMemo, useState } from 'react'

import type { BotConfig, SetupScan } from '../../shared/types'
import { hermes } from './bridge'
import { closeSetup, useStore } from './store'

type Status = 'scanning' | 'done'

interface HostEntry {
  host: string
  status: Status
  scan?: SetupScan
}

const keyOf = (b: { transport: BotConfig['transport'] }) =>
  b.transport.kind === 'ssh' ? `ssh:${b.transport.host}:${b.transport.profile}` : `local:${b.transport.profile}`

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bot'

const DOCS = 'https://hermes-agent.nousresearch.com/docs/'

/** Only keep a custom binary path when it isn't where HermesChan looks by default. */
const customPath = (p: string | null | undefined) => (p && !/\/\.local\/bin\/hermes$/.test(p) ? p : undefined)

export function Setup({ firstRun }: { firstRun: boolean }) {
  const config = useStore(s => s.config)
  const existing = config?.bots ?? []

  const [local, setLocal] = useState<{ status: Status; scan?: SetupScan }>({ status: 'scanning' })
  const [hosts, setHosts] = useState<HostEntry[]>(() =>
    [...new Set(existing.flatMap(b => (b.transport.kind === 'ssh' ? [b.transport.host] : [])))].map(host => ({ host, status: 'scanning' as Status }))
  )
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [hostInput, setHostInput] = useState('')
  const [selected, setSelected] = useState<Record<string, boolean>>(() => Object.fromEntries(existing.map(b => [keyOf(b), true])))
  const [saving, setSaving] = useState(false)

  const scanLocal = async () => {
    setLocal({ status: 'scanning' })
    const scan = await hermes.setupScanLocal()
    setLocal({ status: 'done', scan })
    // First run: tick the default profile so one click gets you going.
    if (firstRun && scan.ok && !existing.length) {
      const pick = scan.profiles.includes('default') ? 'default' : scan.profiles[0]
      if (pick) setSelected(s => ({ [`local:${pick}`]: true, ...s }))
    }
  }

  const scanHost = async (host: string) => {
    setHosts(hs => {
      const rest = hs.filter(h => h.host !== host)
      return [...rest, { host, status: 'scanning' }]
    })
    const scan = await hermes.setupScanRemote(host)
    setHosts(hs => hs.map(h => (h.host === host ? { host, status: 'done', scan } : h)))
    if (scan.ok && scan.profiles.length === 1) setSelected(s => ({ ...s, [`ssh:${host}:${scan.profiles[0]}`]: true }))
  }

  useEffect(() => {
    void scanLocal()
    void hermes.setupSshHosts().then(setSuggestions).catch(() => setSuggestions([]))
    for (const h of hosts) void scanHost(h.host)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (firstRun) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeSetup()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [firstRun])

  const addHost = () => {
    const host = hostInput.trim()
    if (!host) return
    setHostInput('')
    void scanHost(host)
  }

  const toggle = (k: string) => setSelected(s => ({ ...s, [k]: !s[k] }))

  /** The bot list the current ticks describe (existing bots keep their id, name and colour). */
  const nextBots = useMemo((): BotConfig[] => {
    const out: BotConfig[] = []
    const used = new Set<string>()
    const add = (k: string, make: () => BotConfig) => {
      if (!selected[k]) return
      const prev = existing.find(b => keyOf(b) === k)
      let bot = prev ?? make()
      let id = bot.id
      for (let n = 2; used.has(id); n++) id = `${bot.id}-${n}`
      used.add(id)
      bot = { ...bot, id }
      out.push(bot)
    }
    const localProfiles = local.scan?.profiles ?? []
    for (const p of new Set([...localProfiles, ...existing.filter(b => b.transport.kind === 'local').map(b => b.transport.profile)])) {
      add(`local:${p}`, () => ({
        id: p === 'default' ? 'mac' : `mac-${slug(p)}`,
        name: p === 'default' ? 'Hermes' : p,
        transport: { kind: 'local', profile: p, ...(customPath(local.scan?.hermes) ? { hermes: customPath(local.scan?.hermes) } : {}) }
      }))
    }
    for (const h of hosts) {
      const profiles = new Set([
        ...(h.scan?.profiles ?? []),
        ...existing.filter(b => b.transport.kind === 'ssh' && b.transport.host === h.host).map(b => b.transport.profile)
      ])
      for (const p of profiles) {
        add(`ssh:${h.host}:${p}`, () => ({
          id: slug(p === 'default' ? h.host : `${h.host}-${p}`),
          name: p === 'default' ? h.host : p,
          transport: { kind: 'ssh', host: h.host, profile: p, ...(customPath(h.scan?.hermes) ? { hermes: customPath(h.scan?.hermes) } : {}) }
        }))
      }
    }
    return out
  }, [selected, local, hosts, existing])

  const save = async () => {
    if (!nextBots.length || saving) return
    setSaving(true)
    await hermes.setupSave(nextBots)
    // The main process reloads the window; this only matters if it didn't.
    setSaving(false)
  }


  const liveLooks = useLooks()
  const visibleKeys = [
    ...(local.scan?.profiles ?? []).map(p => `local:${p}`),
    ...existing.filter(b => b.transport.kind === 'local').map(b => keyOf(b)),
    ...hosts.flatMap(h => (h.scan?.profiles ?? []).map(p => `ssh:${h.host}:${p}`))
  ]
  const colors = assignColors([...new Set(visibleKeys)].filter(k => !liveLooks[k]))
  const looks: Record<string, Look> = { ...liveLooks }
  for (const [k, color] of Object.entries(colors)) looks[k] = { ...(looks[k] ?? { name: '' }), color, name: looks[k]?.name ?? '' }
  const unseenLocal = existing
    .filter(b => b.transport.kind === 'local' && !(local.scan?.profiles ?? []).includes(b.transport.profile))
    .map(b => b.transport.profile)
  const localProfiles = [...(local.scan?.profiles ?? []), ...unseenLocal]

  return (
    <div className={`setup ${firstRun ? 'first' : 'manage'}`}>
      {firstRun ? (
        <div className="titlebar-drag" />
      ) : (
        <header className="su-bar">
          <div>
            <div className="su-bar-title">Bots</div>
            <div className="su-bar-sub">Each Hermes profile you select becomes a bot in the sidebar.</div>
          </div>
          <button className="su-icon-btn" onClick={closeSetup} aria-label="Close" title="Close (Esc)">
            <Icon.X />
          </button>
        </header>
      )}

      <div className="su-scroll">
        <div className="su-body">
          {firstRun && (
            <header className="su-hero">
              <img className="su-logo" src="./icon.png" alt="" onError={e => ((e.target as HTMLImageElement).style.display = 'none')} />
              <h1>Welcome to HermesChan</h1>
              <p>Connect the Hermes you already run. Choose the profiles you want to chat with; each becomes a bot in your sidebar.</p>
            </header>
          )}

          <Section
            icon={<Icon.Laptop />}
            title="This Mac"
            caption="Profiles found in ~/.hermes"
            badge={<ScanBadge status={local.status} scan={local.scan} />}
            action={
              local.status === 'done' ? (
                <button className="su-icon-btn" onClick={() => void scanLocal()} aria-label="Scan again" title="Scan again">
                  <Icon.Refresh />
                </button>
              ) : null
            }
          >
            {local.status === 'scanning' ? (
              <SkeletonCards />
            ) : local.scan && !local.scan.ok ? (
              <Problem scan={local.scan} />
            ) : (
              <ProfileGrid
                items={localProfiles.map(p => ({ key: `local:${p}`, name: p, detail: p === 'default' ? '~/.hermes' : `profiles/${p}`, label: p === 'default' ? 'Hermes' : p }))}
                selected={selected}
                onToggle={toggle}
                looks={looks}
              />
            )}
          </Section>

          <Section icon={<Icon.Server />} title="Servers" caption="Over SSH with your keys. Nothing is installed on the server.">
            <form
              className="su-field"
              onSubmit={e => {
                e.preventDefault()
                addHost()
              }}
            >
              <span className="su-field-prefix">ssh</span>
              <input
                list="su-hosts"
                placeholder="host or user@address"
                value={hostInput}
                onChange={e => setHostInput(e.target.value)}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
              <datalist id="su-hosts">
                {suggestions.map(h => (
                  <option key={h} value={h} />
                ))}
              </datalist>
              <button className="su-btn" type="submit" disabled={!hostInput.trim()}>
                Check
              </button>
            </form>

            {suggestions.filter(h => !hosts.some(x => x.host === h)).length > 0 && (
              <div className="su-suggest">
                <span className="su-suggest-label">From ~/.ssh/config</span>
                {suggestions
                  .filter(h => !hosts.some(x => x.host === h))
                  .slice(0, 6)
                  .map(h => (
                    <button key={h} className="su-chip" onClick={() => void scanHost(h)}>
                      <Icon.Plus /> {h}
                    </button>
                  ))}
              </div>
            )}

            {hosts.map(h => (
              <div key={h.host} className="su-host">
                <div className="su-host-head">
                  <span className="su-host-name">{h.host}</span>
                  <ScanBadge status={h.status} scan={h.scan} />
                  <span className="su-host-actions">
                    {h.status === 'done' && !h.scan?.ok && (
                      <button className="su-text-btn" onClick={() => void scanHost(h.host)}>
                        Retry
                      </button>
                    )}
                    <button
                      className="su-icon-btn small"
                      aria-label={`Remove ${h.host}`}
                      title="Remove"
                      onClick={() => {
                        setHosts(hs => hs.filter(x => x.host !== h.host))
                        setSelected(s => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith(`ssh:${h.host}:`))))
                      }}
                    >
                      <Icon.X />
                    </button>
                  </span>
                </div>
                {h.status === 'scanning' ? (
                  <SkeletonCards n={1} />
                ) : h.scan && !h.scan.ok ? (
                  <Problem scan={h.scan} />
                ) : (
                  <ProfileGrid
                    items={(h.scan?.profiles ?? []).map(p => ({
                      key: `ssh:${h.host}:${p}`,
                      name: p,
                      detail: p === 'default' ? '~/.hermes' : `profiles/${p}`,
                      label: p === 'default' ? h.host : p
                    }))}
                    selected={selected}
                    onToggle={toggle}
                    looks={looks}
                  />
                )}
              </div>
            ))}
          </Section>
        </div>
      </div>

      <footer className="su-foot">
        <SidebarPreview bots={nextBots} looks={looks} />
        <div className="su-foot-actions">
          {!firstRun && (
            <button className="su-btn ghost" onClick={closeSetup}>
              Cancel
            </button>
          )}
          <button className="su-btn primary" disabled={!nextBots.length || saving} onClick={() => void save()}>
            {saving ? (
              <>
                <span className="su-spin" /> Connecting
              </>
            ) : firstRun ? (
              <>
                Start chatting <Icon.Arrow />
              </>
            ) : (
              'Save changes'
            )}
          </button>
        </div>
      </footer>
    </div>
  )
}

// ─── pieces ────────────────────────────────────────────────────────────────────────────────────

/** A stable on-palette colour for a profile with no Bot Mode colour yet (FNV-1a over its key). */
const HUES = [45, 210, 330, 158, 275, 18, 190, 95]
const hueIndex = (key: string) => {
  let h = 0x811c9dc5
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0
  return h % HUES.length
}
export const colorFor = (key: string) => `hsl(${HUES[hueIndex(key)]} 72% 63%)`

/** Colours for every profile on screen: each starts from its stable hash and steps to the next
 *  free hue on a clash, so no two visible profiles share a colour. */
function assignColors(keys: string[]): Record<string, string> {
  const used = new Set<number>()
  const out: Record<string, string> = {}
  for (const k of keys) {
    let i = hueIndex(k)
    for (let n = 0; n < HUES.length && used.has(i); n++) i = (i + 1) % HUES.length
    used.add(i)
    out[k] = `hsl(${HUES[i]} 72% 63%)`
  }
  return out
}

/** How an existing bot looks in the sidebar (real avatar, colour, display name), if we know it. */
type Look = { name: string; color: string; avatar?: string }
function useLooks(): Record<string, Look> {
  const config = useStore(s => s.config)
  const bots = useStore(s => s.bots)
  return useMemo(() => {
    const out: Record<string, Look> = {}
    for (const b of config?.bots ?? []) {
      const live = bots[b.id]
      out[keyOf(b)] = { name: live?.name ?? b.name ?? b.id, color: live?.color ?? b.color ?? colorFor(keyOf(b)), avatar: live?.avatar }
    }
    return out
  }, [config, bots])
}
const initials = (name: string) =>
  name
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]!.toUpperCase())
    .join('') || '?'

function Tile({ name, color, avatar, size = 36 }: { name: string; color: string; avatar?: string; size?: number }) {
  return (
    <span className="su-tile" style={{ width: size, height: size, fontSize: size * 0.38, background: color }}>
      {avatar ? <img src={avatar} alt="" /> : initials(name)}
    </span>
  )
}

function Section({
  icon,
  title,
  caption,
  badge,
  action,
  children
}: {
  icon: React.ReactNode
  title: string
  caption: string
  badge?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="su-section">
      <div className="su-section-head">
        <span className="su-section-icon">{icon}</span>
        <div className="su-section-text">
          <div className="su-section-title">
            {title}
            {badge}
          </div>
          <div className="su-section-caption">{caption}</div>
        </div>
        {action}
      </div>
      <div className="su-section-body">{children}</div>
    </section>
  )
}

function ScanBadge({ status, scan }: { status: Status; scan?: SetupScan }) {
  if (status === 'scanning')
    return (
      <span className="su-badge">
        <span className="su-spin" /> Checking
      </span>
    )
  if (!scan) return null
  if (!scan.ok) return <span className="su-badge bad">Needs attention</span>
  const v = scan.version?.match(/v[\w.-]+/)?.[0]
  return (
    <span className="su-badge ok">
      <Icon.Check /> Found{v ? ` · ${v}` : ''}
    </span>
  )
}

function ProfileGrid({
  items,
  selected,
  onToggle,
  looks
}: {
  items: { key: string; name: string; detail: string; label: string }[]
  selected: Record<string, boolean>
  onToggle: (k: string) => void
  looks: Record<string, Look>
}) {
  return (
    <div className="su-grid">
      {items.map(it => {
        const on = !!selected[it.key]
        return (
          <button key={it.key} className={`su-card ${on ? 'on' : ''}`} onClick={() => onToggle(it.key)} aria-pressed={on}>
            <Tile name={looks[it.key]?.name || it.label} color={looks[it.key]?.color ?? colorFor(it.key)} avatar={looks[it.key]?.avatar} />
            <span className="su-card-text">
              <span className="su-card-name">{looks[it.key]?.name || it.name}</span>
              <span className="su-card-detail">{it.detail}</span>
            </span>
            <span className={`su-tick ${on ? 'on' : ''}`}>{on && <Icon.Check />}</span>
          </button>
        )
      })}
    </div>
  )
}

function SkeletonCards({ n = 2 }: { n?: number }) {
  return (
    <div className="su-grid">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="su-card skeleton">
          <span className="su-tile shimmer-box" style={{ width: 36, height: 36 }} />
          <span className="su-card-text">
            <span className="su-skel-line shimmer-box" style={{ width: '60%' }} />
            <span className="su-skel-line shimmer-box" style={{ width: '40%' }} />
          </span>
        </div>
      ))}
    </div>
  )
}

/** A failed scan: what happened, and the one thing to do about it (copyable when it's a command). */
function Problem({ scan }: { scan: SetupScan }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="su-problem">
      <Icon.Alert />
      <div className="su-problem-text">
        <div className="su-problem-title">{scan.error}</div>
        {scan.hint && <div className="su-problem-hint">{scan.hint}</div>}
        {(scan.command || scan.install) && (
          <div className="su-problem-actions">
            {scan.command && (
              <button
                className="su-code"
                onClick={() => {
                  void navigator.clipboard.writeText(scan.command!)
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1400)
                }}
                title="Copy"
              >
                <code>{scan.command}</code>
                <span className="su-code-copy">{copied ? <Icon.Check /> : <Icon.Copy />}</span>
              </button>
            )}
            {scan.install && (
              <button className="su-text-btn" onClick={() => window.hermes.openExternal(DOCS)}>
                Install guide <Icon.External />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** What the sidebar will look like with the current selection. */
function SidebarPreview({ bots, looks }: { bots: BotConfig[]; looks: Record<string, Look> }) {
  const nameOf = (b: BotConfig) => looks[keyOf(b)]?.name || b.name || b.id
  return (
    <div className="su-preview" aria-label="Sidebar preview">
      <div className="su-preview-tiles">
        {bots.slice(0, 6).map((b, i) => (
          <span key={b.id} className="su-preview-tile" style={{ animationDelay: `${i * 30}ms` }}>
            <Tile name={nameOf(b)} color={looks[keyOf(b)]?.color ?? b.color ?? colorFor(keyOf(b))} avatar={looks[keyOf(b)]?.avatar} size={30} />
          </span>
        ))}
        {bots.length === 0 && <span className="su-preview-empty" />}
      </div>
      <div className="su-preview-text">
        <b>{bots.length ? `${bots.length} bot${bots.length === 1 ? '' : 's'}` : 'No bots yet'}</b>
        <span>{bots.length ? bots.map(nameOf).slice(0, 3).join(', ') + (bots.length > 3 ? '…' : '') : 'Select at least one profile'}</span>
      </div>
    </div>
  )
}

// ─── icons (1.6px line set) ────────────────────────────────────────────────────────────────────

const svg = (d: React.ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
)

const Icon = {
  Laptop: () => svg(<><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2 19h20" /></>, 18),
  Server: () => svg(<><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>, 18),
  Refresh: () => svg(<><path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4" /></>),
  Check: () => svg(<path d="M5 12.5l4.5 4.5L19 7.5" />, 14),
  X: () => svg(<path d="M6 6l12 12M18 6L6 18" />),
  Plus: () => svg(<path d="M12 5v14M5 12h14" />, 12),
  Arrow: () => svg(<path d="M5 12h14M13 6l6 6-6 6" />),
  Alert: () => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16h.01" /></>, 18),
  Copy: () => svg(<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>, 14),
  External: () => svg(<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />, 13)
}
