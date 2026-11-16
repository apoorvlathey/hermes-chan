const DAY = 86_400

const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000

export function bucket(ts: number): string {
  const today = startOfDay()
  if (ts >= today) return 'Today'
  if (ts >= today - DAY) return 'Yesterday'
  if (ts >= today - 6 * DAY) return 'This week'
  if (ts >= today - 29 * DAY) return 'This month'
  return 'Older'
}

export function ago(ts: number): string {
  const s = Math.max(0, Date.now() / 1000 - ts)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < DAY) return `${Math.floor(s / 3600)}h`
  if (s < 7 * DAY) return `${Math.floor(s / DAY)}d`
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function clock(ts?: number): string {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
