import { useEffect, useMemo, useRef, useState } from 'react'

import {
  applyPick,
  capsFor,
  EFFORTS,
  loadModelOptions,
  modelKey,
  presetFor,
  setShowAll,
  useModels,
  type ProviderModels
} from './models'
import { type Bot, useStore } from './store'

const EFFORT_LABEL: Record<string, string> = { low: 'Low', medium: 'Med', high: 'High', xhigh: 'Max' }

/** "anthropic/claude-opus-5.5" → ["anthropic/", "claude-opus-5.5"] so the vendor prefix can be dimmed. */
function splitName(model: string): [string, string] {
  const i = model.lastIndexOf('/')
  return i < 0 ? ['', model] : [model.slice(0, i + 1), model.slice(i + 1)]
}

export function ModelPicker({ threadKey, bot }: { threadKey: string | null; bot: Bot }) {
  const pick = useStore(s => (threadKey ? s.threads[threadKey]?.model : undefined))
  const liveId = useStore(s => (threadKey ? s.threads[threadKey]?.liveId : undefined))
  const running = useStore(s => (threadKey ? !!s.threads[threadKey]?.running : false))
  const { options, loading, favorites, showAll } = useModels()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  const inv = options[bot.id]
  const model = pick?.model ?? inv?.model ?? bot.model ?? ''
  const provider = pick?.provider ?? inv?.provider ?? ''
  const caps = capsFor(bot.id, provider, model)

  useEffect(() => {
    if (!open) return
    void loadModelOptions(bot.id, liveId)
    setError(null)
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, bot.id, liveId])

  const run = async (change: Parameters<typeof applyPick>[1]) => {
    if (!threadKey) return
    setBusy(true)
    setError(null)
    const err = await applyPick(threadKey, change)
    setBusy(false)
    if (err) setError(err)
    return !err
  }

  const choose = async (p: ProviderModels, m: string) => {
    const preset = presetFor(p.slug, m)
    const c = p.caps[m] ?? {}
    const ok = await run({
      model: m,
      provider: p.slug,
      ...(c.reasoning && preset.effort ? { effort: preset.effort } : {}),
      ...(c.fast && preset.fast !== undefined ? { fast: preset.fast } : {})
    })
    if (ok) setOpen(false)
  }

  const sections = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const match = (m: string) => !needle || m.toLowerCase().includes(needle)
    const providers = inv?.providers ?? []
    const favRows = favorites
      .map(f => {
        const [slug, m] = f.split('::')
        const p = providers.find(x => x.slug === slug)
        return p && m && p.models.includes(m) && match(m) ? { p, m } : null
      })
      .filter(Boolean) as { p: ProviderModels; m: string }[]
    const groups = providers
      .map(p => ({ p, models: p.models.filter(match) }))
      .filter(g => g.models.length)
      // The session's current provider first.
      .sort((a, b) => Number(b.p.slug === provider) - Number(a.p.slug === provider))
    return { favRows, groups }
  }, [inv, favorites, q, provider])

  const [vendor, short] = splitName(model)

  return (
    <div className="model-picker" ref={root}>
      <button className={`model-trigger ${open ? 'open' : ''}`} onClick={() => setOpen(o => !o)} title="Switch model">
        <span className="model-name">
          {vendor && <span className="model-vendor">{vendor}</span>}
          {short || 'model'}
        </span>
        {pick?.fast && <span className="model-flag">⚡</span>}
        {pick?.effort && <span className="model-effort">{EFFORT_LABEL[pick.effort] ?? pick.effort}</span>}
        <span className="chev">▾</span>
      </button>

      {open && (
        <div className="model-pop">
          <div className="model-search">
            <span className="search-icon">⌕</span>
            <input autoFocus placeholder="Search models" value={q} onChange={e => setQ(e.target.value)} />
          </div>

          <div className="model-list">
            {!inv && loading[bot.id] && <div className="model-empty shimmer">Loading models…</div>}
            {inv && !sections.groups.length && <div className="model-empty">No models match.</div>}

            {sections.favRows.length > 0 && (
              <section>
                <h5>★ Favorites</h5>
                {sections.favRows.map(({ p, m }) => (
                  <ModelRow key={`fav-${modelKey(p.slug, m)}`} p={p} m={m} current={m === model && p.slug === provider} onPick={choose} showProvider />
                ))}
              </section>
            )}

            {sections.groups.map(({ p, models }) => (
              <section key={p.slug}>
                <h5>{p.name}</h5>
                {models.map(m => (
                  <ModelRow key={modelKey(p.slug, m)} p={p} m={m} current={m === model && p.slug === provider} onPick={choose} />
                ))}
              </section>
            ))}

            {inv && (
              <button className="model-showall" onClick={() => setShowAll(bot.id, !showAll, liveId)}>
                {showAll ? 'Only show providers I set up' : 'Show all providers'}
              </button>
            )}
          </div>

          <div className="model-foot">
            <div className="model-setting">
              <span>Effort</span>
              <div className={`seg ${caps.reasoning === false ? 'disabled' : ''}`}>
                {EFFORTS.map(e => (
                  <button
                    key={e}
                    className={pick?.effort === e ? 'on' : ''}
                    disabled={busy || caps.reasoning === false}
                    onClick={() => void run({ effort: e })}
                  >
                    {EFFORT_LABEL[e]}
                  </button>
                ))}
              </div>
            </div>
            <div className="model-setting">
              <span>
                Fast <span className="hint">⚡ priority tier</span>
              </span>
              <button
                className={`toggle ${pick?.fast ? 'on' : ''}`}
                disabled={busy || !caps.fast}
                title={caps.fast ? '' : "This model doesn't offer fast mode"}
                onClick={() => void run({ fast: !pick?.fast })}
                aria-pressed={!!pick?.fast}
              >
                <i />
              </button>
            </div>
            {error && <div className="model-error">{error}</div>}
            {running && !error && <div className="model-note">Changes apply from the next message.</div>}
          </div>
        </div>
      )}
    </div>
  )
}

function ModelRow({
  p,
  m,
  current,
  onPick,
  showProvider
}: {
  p: ProviderModels
  m: string
  current: boolean
  onPick: (p: ProviderModels, m: string) => void
  showProvider?: boolean
}) {
  const c = p.caps[m] ?? {}
  const [vendor, short] = splitName(m)
  return (
    <button className={`model-row ${current ? 'current' : ''}`} onClick={() => onPick(p, m)}>
      <span className="model-row-name">
        {vendor && <span className="model-vendor">{vendor}</span>}
        {short}
      </span>
      {showProvider && <span className="model-row-prov">{p.name}</span>}
      {c.fast && <span className="model-row-badge" title="Fast mode available">⚡</span>}
      {current && <span className="model-row-check">✓</span>}
    </button>
  )
}
