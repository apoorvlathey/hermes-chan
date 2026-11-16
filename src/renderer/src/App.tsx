import { useEffect } from 'react'

import { Chat } from './Chat'
import { Sidebar } from './Sidebar'
import { getState, newChat, openBot, useStore } from './store'

export function App() {
  const view = useStore(s => s.view)

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

  return (
    <div className="app">
      <Sidebar />
      <main className="main">{view ? <Chat /> : <div className="boot">Waking the bots…</div>}</main>
    </div>
  )
}
