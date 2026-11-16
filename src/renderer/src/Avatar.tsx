import type { Bot } from './store'

const initials = (name: string) =>
  name
    .split(/[\s-_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]!.toUpperCase())
    .join('')

export function Avatar({ bot, size = 44, className = '' }: { bot: Bot; size?: number; className?: string }) {
  return (
    <div
      className={`avatar ${className}`}
      style={{ width: size, height: size, ['--bot' as string]: bot.color, fontSize: size * 0.36 }}
      aria-hidden
    >
      {bot.avatar ? <img src={bot.avatar} alt="" draggable={false} /> : <span>{initials(bot.name)}</span>}
    </div>
  )
}
