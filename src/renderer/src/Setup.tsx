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

function Check({ on }: { on: boolean }) {
  return <span className={`su-check ${on ? 'on' : ''}`}>{on ? '✓' : ''}</span>
}

function ScanLine({ status, scan, what }: { status: Status; scan?: SetupScan; what: string }) {
  if (status === 'scanning')
    return (
      <div className="su-status">
        <span className="session-spinner" /> Looking for Hermes {what}…
      </div>
    )
  if (!scan) return null
  if (scan.ok)
    return (
      <div className="su-status ok">
        <span className="su-dot ok" />
        {scan.version ?? 'Hermes Agent'} · {scan.profiles.length} profile{scan.profiles.length === 1 ? '' : 's'}
      </div>
    )
  return (
    <div className="su-status bad">
      <span className="su-dot bad" />
      <span>
        <b>{scan.error}</b>
        {scan.hint && (
          <span className="su-hint">
            {scan.hint.includes('nousresearch.com') ? (
              <>
                Install Hermes Agent first:{' '}
                <a onClick={() => window.hermes.openExternal(DOCS)}>hermes-agent.nousresearch.com/docs</a>
              </>
            ) : (
              renderCode(scan.hint)
            )}
          </span>
        )}
      </span>
    </div>
  )
}

/** `backticks` in hints render as code. */
const renderCode = (text: string) =>
  text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : <span key={i}>{part}</span>))

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

  const ProfileList = ({ prefix, profiles, note }: { prefix: string; profiles: string[]; note?: (p: string) => string | undefined }) =>
    profiles.length ? (
      <div className="su-profiles">
        {profiles.map(p => {
          const k = `${prefix}:${p}`
          return (
            <button key={k} className={`su-profile ${selected[k] ? 'on' : ''}`} onClick={() => toggle(k)}>
              <Check on={!!selected[k]} />
              <span className="su-profile-name">{p}</span>
              <span className="su-profile-note">{note?.(p) ?? (p === 'default' ? 'main profile' : 'profile')}</span>
            </button>
          )
        })}
      </div>
    ) : null

  const unseenLocal = existing.filter(b => b.transport.kind === 'local' && !(local.scan?.profiles ?? []).includes(b.transport.profile)).map(b => b.transport.profile)

  return (
    <div className={`setup ${firstRun ? 'first' : 'manage'}`}>
      <div className="titlebar-drag" />
      <div className="su-panel">
        <header className="su-head">
          {firstRun && <img className="su-logo" src="./icon.png" alt="" onError={e => ((e.target as HTMLImageElement).style.display = 'none')} />}
          <h1>{firstRun ? 'Welcome to HermesChan' : 'Your bots'}</h1>
          <p>
            {firstRun
              ? 'Let’s find your Hermes. Pick the profiles you want to chat with; each one becomes a bot in the sidebar.'
              : 'Add or remove bots. Each Hermes profile you tick shows up in the sidebar.'}
          </p>
        </header>

        <section className="su-card">
          <div className="su-card-head">
            <span className="su-emoji">💻</span>
            <div>
              <h2>On this Mac</h2>
              <ScanLine status={local.status} scan={local.scan} what="on this Mac" />
            </div>
            {local.status === 'done' && (
              <button className="su-ghost" onClick={() => void scanLocal()}>
                Scan again
              </button>
            )}
          </div>
          <ProfileList prefix="local" profiles={[...(local.scan?.profiles ?? []), ...unseenLocal]} />
        </section>

        <section className="su-card">
          <div className="su-card-head">
            <span className="su-emoji">🌐</span>
            <div>
              <h2>On a server</h2>
              <div className="su-status">Over SSH with your keys. Nothing gets installed on the server.</div>
            </div>
          </div>

          <form
            className="su-add"
            onSubmit={e => {
              e.preventDefault()
              addHost()
            }}
          >
            <input
              list="su-hosts"
              placeholder={suggestions[0] ? `Host from ~/.ssh/config, e.g. ${suggestions[0]}` : 'SSH host, e.g. my-server or user@1.2.3.4'}
              value={hostInput}
              onChange={e => setHostInput(e.target.value)}
              spellCheck={false}
            />
            <datalist id="su-hosts">
              {suggestions.map(h => (
                <option key={h} value={h} />
              ))}
            </datalist>
            <button className="su-btn" type="submit" disabled={!hostInput.trim()}>
              Connect
            </button>
          </form>
          {suggestions.length > 0 && !hosts.length && (
            <div className="su-suggest">
              {suggestions.slice(0, 6).map(h => (
                <button key={h} className="su-chip" onClick={() => void scanHost(h)}>
                  {h}
                </button>
              ))}
            </div>
          )}

          {hosts.map(h => (
            <div key={h.host} className="su-host">
              <div className="su-host-head">
                <span className="su-host-name">{h.host}</span>
                <ScanLine status={h.status} scan={h.scan} what={`on ${h.host}`} />
                {h.status === 'done' && (
                  <span className="su-host-actions">
                    {!h.scan?.ok && (
                      <button className="su-ghost" onClick={() => void scanHost(h.host)}>
                        Try again
                      </button>
                    )}
                    <button
                      className="su-ghost"
                      onClick={() => {
                        setHosts(hs => hs.filter(x => x.host !== h.host))
                        setSelected(s => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith(`ssh:${h.host}:`))))
                      }}
                    >
                      Remove
                    </button>
                  </span>
                )}
              </div>
              <ProfileList prefix={`ssh:${h.host}`} profiles={h.scan?.profiles ?? []} />
            </div>
          ))}
        </section>
      </div>

      <footer className="su-foot">
        <span className="su-count">
          {nextBots.length ? `${nextBots.length} bot${nextBots.length === 1 ? '' : 's'} selected` : 'Tick at least one profile'}
        </span>
        {!firstRun && (
          <button className="su-ghost" onClick={closeSetup}>
            Cancel
          </button>
        )}
        <button className="su-btn primary" disabled={!nextBots.length || saving} onClick={() => void save()}>
          {saving ? (
            <>
              <span className="session-spinner" /> Connecting…
            </>
          ) : firstRun ? (
            'Start chatting →'
          ) : (
            'Save'
          )}
        </button>
      </footer>
    </div>
  )
}
