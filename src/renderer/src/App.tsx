import { useEffect, useState } from 'react'
import { Kanban } from './Kanban'
import './kanban.css'

import { Chat } from './Chat'
import { Setup } from './Setup'
import { Sidebar } from './Sidebar'
import { getState, newChat, openBot, useStore } from './store'
import { WorkstreamsPanel } from './Workstreams'

export function App() {
  const view = useStore(s => s.view)
  const noBots = useStore(s => !!s.config && s.config.bots.length === 0)
  const setupOpen = useStore(s => s.setupOpen)
  const config = useStore(s => s.config)
  const activeBotId = useStore(s => s.view?.kind === 'session' ? s.threads[s.view.key]?.botId : s.view?.botId)
  const [tab, setTab] = useState<'chat' | 'kanban'>('chat')
  // Clicking a bot/chat in the existing sidebar returns to that conversation.
  useEffect(() => setTab('chat'), [view])

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
        <nav className="workspace-tabs" aria-label="Workspace">
          <button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button>
          <button aria-pressed={tab === 'kanban'} onClick={() => setTab('kanban')}>Kanban</button>
        </nav>
        {tab === 'kanban' && config ? <Kanban bots={config.bots} initialBotId={activeBotId} /> : view ? (
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
