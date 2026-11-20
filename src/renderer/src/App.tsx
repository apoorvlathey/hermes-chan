import { useEffect } from 'react'

import { Chat } from './Chat'
import { Kanban } from './Kanban'
import { Setup } from './Setup'
import { Sidebar } from './Sidebar'
import { getState, newChat, openBot, useStore } from './store'
import { WorkstreamsPanel } from './Workstreams'

export function App() {
  const view = useStore(s => s.view)
  const noBots = useStore(s => !!s.config && s.config.bots.length === 0)
  const setupOpen = useStore(s => s.setupOpen)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      if (e.key === 'n') {
        e.preventDefault()
        newChat(view?.kind === 'session' ? undefined : view?.botId)
      } else if (e.key === 'k') {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('#search')?.focus()
      } else if (/^[1-9]$/.test(e.key)) {
        const bot = getState().config?.bots[Number(e.key) - 1]
        if (bot) {
          e.preventDefault()
          openBot(bot.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  // A fresh install has no bots yet: the whole window is the getting-started flow.
  if (noBots) return <Setup firstRun />

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {view?.kind === 'kanban' ? (
          <Kanban />
        ) : view ? (
          <div className="main-split">
            <Chat />
            <WorkstreamsPanel />
          </div>
        ) : (
          <div className="boot">Waking the bots…</div>
        )}
      </main>
      {setupOpen && (
        <div className="setup-overlay">
          <Setup firstRun={false} />
        </div>
      )}
    </div>
  )
}
