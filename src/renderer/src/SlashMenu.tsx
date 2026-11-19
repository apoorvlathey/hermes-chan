/** The composer's `/` menu: the bot's commands and skills as you type a command, then the gateway's
 *  completions for its argument (`/reasoning ` → low, medium, high). */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { catalogNow, completeArgs, loadCatalog, matchCommands, type ArgItem, type Catalog, type SlashCommand } from './slash'

type Row = { kind: 'cmd'; cmd: SlashCommand } | { kind: 'arg'; item: ArgItem; from: number }

export function useSlashMenu(opts: {
  botId: string
  sessionId?: string
  text: string
  setText: (t: string) => void
  /** Send this text now (a command that needs nothing more). */
  run: (t: string) => void
}) {
  const { botId, sessionId, text, setText, run } = opts
  const [catalog, setCatalog] = useState<Catalog | undefined>(() => catalogNow(botId))
  const [active, setActive] = useState(0)
  /** The text the menu was dismissed at (Esc); it comes back once the text changes. */
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [args, setArgs] = useState<{ text: string; from: number; items: ArgItem[] } | null>(null)

  useEffect(() => {
    setCatalog(catalogNow(botId))
    if (!text.startsWith('/')) return
    let live = true
    loadCatalog(botId)
      .then(c => live && setCatalog(c))
      .catch(() => undefined)
    return () => {
      live = false
    }
    // Fetch on the first `/`, not on every keystroke.
  }, [botId, text.startsWith('/')])

  const cmdQuery = /^\/([\w-]*)$/.exec(text)?.[1]
  const argCmd = useMemo(() => {
    const m = /^(\/[\w-]+)\s/.exec(text)
    if (!m || !catalog || text.includes('\n')) return null
    const c = catalog.byName.get(m[1].toLowerCase())
    return c && !c.unavailable && (c.args === 'options' || c.args === 'mixed') ? c : null
  }, [text, catalog])

  // Argument completions come from the gateway; ask after a short pause in typing.
  useEffect(() => {
    if (!argCmd) {
      setArgs(null)
      return
    }
    let live = true
    const t = window.setTimeout(() => {
      completeArgs(botId, text, sessionId)
        .then(r => live && setArgs({ text, ...r }))
        .catch(() => live && setArgs(null))
    }, 90)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [argCmd, text, botId, sessionId])

  const rows: Row[] = useMemo(() => {
    if (cmdQuery !== undefined && catalog) return matchCommands(catalog, cmdQuery).map(cmd => ({ kind: 'cmd', cmd }))
    if (argCmd && args && args.text.startsWith(text.slice(0, args.from))) {
      // Don't offer what's already typed in full.
      return args.items.filter(i => text.slice(0, args.from) + i.text !== text.trimEnd()).map(item => ({ kind: 'arg', item, from: args.from }))
    }
    return []
  }, [cmdQuery, catalog, argCmd, args, text])

  const open = rows.length > 0 && dismissed !== text
  useEffect(() => setActive(0), [cmdQuery, argCmd?.name, rows.length])
  useEffect(() => {
    if (dismissed !== null && dismissed !== text) setDismissed(null)
  }, [text, dismissed])

  const accept = (row: Row, how: 'enter' | 'tab' | 'click') => {
    if (row.kind === 'cmd') {
      const { cmd } = row
      // Enter runs a command that needs nothing more, or one typed out in full (its argument is
      // optional); otherwise it fills the name in so the argument can follow.
      if (how !== 'tab' && (!cmd.args || text.trim().toLowerCase() === cmd.name)) run(cmd.name)
      else setText(cmd.args ? `${cmd.name} ` : cmd.name)
      return
    }
    setText(text.slice(0, row.from) + row.item.text)
  }

  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open || e.nativeEvent.isComposing) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setActive(a => (a + d + rows.length) % rows.length)
      return true
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault()
      accept(rows[Math.min(active, rows.length - 1)], e.key === 'Tab' ? 'tab' : 'enter')
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setDismissed(text)
      return true
    }
    return false
  }

  const menu = open ? <SlashMenu rows={rows} grouped={cmdQuery === ''} active={active} setActive={setActive} accept={row => accept(row, 'click')} /> : null
  return { menu, onKeyDown, open }
}

function SlashMenu({ rows, grouped, active, setActive, accept }: { rows: Row[]; grouped: boolean; active: number; setActive: (i: number) => void; accept: (r: Row) => void }) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  let lastGroup = ''
  return (
    <div className="slash-menu" role="listbox" onMouseDown={e => e.preventDefault()}>
      <div className="slash-list" ref={list}>
        {rows.map((row, i) => {
          // Sections only for the full list; filtered results are ranked by match, not by section.
          const group = grouped && row.kind === 'cmd' ? row.cmd.group : ''
          const head = group && group !== lastGroup ? group : null
          lastGroup = group
          return (
            <div key={row.kind === 'cmd' ? row.cmd.name : `${row.from}:${row.item.text}`}>
              {head && <div className="slash-group">{head}</div>}
              <div
                className={`slash-row ${i === active ? 'on' : ''}`}
                role="option"
                aria-selected={i === active}
                data-i={i}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => accept(row)}
              >
                <span className="slash-name">{row.kind === 'cmd' ? row.cmd.name : row.item.display}</span>
                <span className="slash-desc">{row.kind === 'cmd' ? row.cmd.desc : row.item.meta}</span>
              </div>
            </div>
          )
        })}
      </div>
      <div className="slash-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to move
        </span>
        <span>
          <kbd>↵</kbd> to run
        </span>
        <span>
          <kbd>tab</kbd> to fill in
        </span>
        <span>
          <kbd>esc</kbd> to close
        </span>
      </div>
    </div>
  )
}
