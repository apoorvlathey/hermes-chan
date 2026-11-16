/** Bot Chat presentation, following a Hermes Desktop Bot Mode layout customization
 *  (bot-chat-layout): chat-app bubbles with a real date+time on each message and
 *  Today / Yesterday / date dividers. Times use this Mac's local timezone (whatever it is when the
 *  app runs). Only Bot Chats use it; ordinary sessions keep the document layout. Times come only
 *  from the backend's stored timestamps — an undated row shows none. */
import { useSyncExternalStore } from 'react'

// Formatters resolve the timezone when built, so rebuild them whenever the Mac's zone changes
// (travel with the app open): cached per zone name.
let zone = ''
let dayFormat: Intl.DateTimeFormat
let dateTime: Intl.DateTimeFormat
function fmt() {
  const z = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (z !== zone) {
    zone = z
    dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: z, day: 'numeric', month: 'short', year: 'numeric' })
    dateTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: z,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
  }
  return { dayFormat, dateTime }
}

const validDate = (ts?: number) => (typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null)

/** Local calendar day of a backend timestamp (seconds), or null when unknown. */
export const localDay = (ts?: number) => {
  const d = validDate(ts)
  return d ? fmt().dayFormat.format(d) : null
}

// ─── one shared "what day is it" clock for every bubble and divider ─────────────────────────────

const msUntilLocalMidnight = () => {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return next.getTime() - now.getTime()
}

let todayStamp = Date.now()
const dayListeners = new Set<() => void>()
let timer: number | undefined

function tick() {
  // Only notify when the local calendar day actually changed.
  const changed = fmt().dayFormat.format(new Date()) !== fmt().dayFormat.format(new Date(todayStamp))
  todayStamp = Date.now()
  if (changed) dayListeners.forEach(f => f())
  schedule()
}

function schedule() {
  window.clearTimeout(timer)
  timer = window.setTimeout(tick, msUntilLocalMidnight() + 50)
}

if (typeof window !== 'undefined') {
  schedule()
  // Sleep / long background can skip the timer; re-check on return.
  document.addEventListener('visibilitychange', tick)
  window.addEventListener('focus', tick)
}

/** Re-renders at local midnight (and after sleep); returns the current "now". */
function useToday(): number {
  return useSyncExternalStore(
    cb => {
      dayListeners.add(cb)
      return () => {
        dayListeners.delete(cb)
      }
    },
    () => todayStamp
  )
}

type Rel = 'today' | 'yesterday' | 'older'

function relDay(d: Date, now: number): Rel {
  const { dayFormat } = fmt()
  const n = new Date(now)
  const day = dayFormat.format(d)
  if (day === dayFormat.format(n)) return 'today'
  if (day === dayFormat.format(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1))) return 'yesterday'
  return 'older'
}

const timeFormat = () =>
  new Intl.DateTimeFormat('en-GB', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** "19:51" today, "Yesterday, 19:51", then "14 Nov 2026, 19:51". The full stamp is on hover. */
export function BotTime({ ts }: { ts?: number }) {
  const now = useToday()
  const d = validDate(ts)
  if (!d) return null
  const rel = relDay(d, now)
  const label =
    rel === 'today' ? timeFormat().format(d) : rel === 'yesterday' ? `Yesterday, ${timeFormat().format(d)}` : fmt().dateTime.format(d)
  return (
    <time className="bot-time" dateTime={d.toISOString()} title={fmt().dateTime.format(d)}>
      {label}
    </time>
  )
}

export function BotDayDivider({ ts }: { ts: number }) {
  const now = useToday()
  const d = new Date(ts * 1000)
  const rel = relDay(d, now)
  return (
    <div className="bot-day-divider">
      <span>{rel === 'today' ? 'Today' : rel === 'yesterday' ? 'Yesterday' : fmt().dayFormat.format(d)}</span>
    </div>
  )
}
