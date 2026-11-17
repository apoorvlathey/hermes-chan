/** Demo mode (`pnpm demo`): a fake Hermes backend with made-up bots, chats and models, so the UI can
 *  be shown or screenshotted without connecting to any gateway or exposing real history. The main
 *  process starts no connections and uses a separate userData folder in this mode. */
import type { BotStatus, HermesBridge } from '../../shared/types'

export const IS_DEMO = new URLSearchParams(location.search).has('demo')

// ─── time helpers (relative to now, local time) ────────────────────────────────────────────────

const at = (daysAgo: number, h: number, m: number) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h, m, 0, 0)
  return d.getTime() / 1000
}
const minsAgo = (n: number) => Date.now() / 1000 - n * 60

// ─── bots ──────────────────────────────────────────────────────────────────────────────────────

const avatar = (bg: string, emoji: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${bg}"/><text x="50" y="54" font-size="58" text-anchor="middle" dominant-baseline="middle">${emoji}</text></svg>`
  )}`

const BOTS = [
  { id: 'atlas', name: 'Atlas', color: 'hsl(45 92% 62%)', emoji: '🦉', model: 'claude-opus-5.5', description: 'Chief of staff: calendar, inbox, travel and the daily brief.' },
  { id: 'pixel', name: 'Pixel', color: 'hsl(330 80% 70%)', emoji: '🎨', model: 'gpt-6.1-sol', description: 'Design and copy partner for side projects.' },
  { id: 'sage', name: 'Sage', color: 'hsl(158 55% 55%)', emoji: '🌿', model: 'claude-sonnet-5.5', description: 'Research, reading notes and deep dives.' }
] as const

type BotId = (typeof BOTS)[number]['id']

// ─── chats ─────────────────────────────────────────────────────────────────────────────────────

interface Row {
  id: string
  bot: BotId
  title: string
  preview: string
  last: number
  count: number
  pinned?: boolean
  running?: boolean
  source?: string
}

const ROWS: Row[] = [
  { id: 'lisbon', bot: 'atlas', title: 'Lisbon trip planning', preview: 'Find flights and a quiet place near Alfama', last: at(1, 21, 5), count: 24, pinned: true },
  { id: 'newsletter', bot: 'pixel', title: 'Q4 newsletter draft', preview: 'Tighten the intro and add a CTA', last: at(2, 17, 40), count: 18, pinned: true },
  { id: 'hero', bot: 'pixel', title: 'Landing page hero copy', preview: 'Three headline options for a habit tracker', last: minsAgo(6), count: 6 },
  { id: 'vectordb', bot: 'sage', title: 'Compare vector databases', preview: 'pgvector vs Qdrant vs LanceDB for 5M docs', last: minsAgo(2), count: 9, running: true },
  { id: 'ci', bot: 'atlas', title: 'Fix flaky CI on the api repo', preview: 'Integration tests time out on cold cache', last: minsAgo(48), count: 14 },
  { id: 'groceries', bot: 'sage', title: 'Weekly grocery list', preview: 'High-protein, vegetarian, under 40 minutes', last: minsAgo(130), count: 5 },
  { id: 'podcast', bot: 'sage', title: 'Podcast episode notes', preview: 'Summarise the episode on sleep and memory', last: at(1, 19, 12), count: 8 },
  { id: 'auth', bot: 'atlas', title: 'Refactor auth middleware', preview: 'Split session and token checks', last: at(1, 11, 30), count: 21 },
  { id: 'gifts', bot: 'pixel', title: 'Gift ideas for Sam', preview: 'Under $80, loves climbing and coffee', last: at(3, 20, 2), count: 7 },
  { id: 'paper', bot: 'sage', title: 'Reading: transformer scaling laws', preview: 'Key takeaways in plain English', last: at(4, 9, 15), count: 12 },
  ...Array.from({ length: 9 }, (_, i): Row => ({
    id: `cron-${i}`,
    bot: (['atlas', 'sage', 'pixel'] as const)[i % 3],
    title: '',
    preview: '',
    last: minsAgo(15 + i * 30),
    count: 2,
    source: 'cron'
  }))
]

const BOT_CHAT = (bot: BotId) => `${bot}-botchat`

// ─── transcripts ───────────────────────────────────────────────────────────────────────────────

const tool = (emoji: string, text: string, preview: string, ts: number) => ({
  role: 'tool',
  name: 'tool_call',
  labels: [{ emoji, text, preview }],
  timestamp: ts
})
const user = (text: string, ts: number) => ({ role: 'user', text, timestamp: ts })
const bot = (text: string, ts: number) => ({ role: 'assistant', text, timestamp: ts })
const cronReport = (job: string, text: string, ts: number) => ({
  role: 'user',
  display_kind: 'internal_notification',
  display_metadata: { completion_note: [JSON.stringify(['cron', 'demo-route', `run-${ts}`])] },
  text: `[Cron job "[bot:default] ${job}" report: shown in the chat, no reply asked for]\n\n${text}`,
  timestamp: ts
})

const todayLabel = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })

const TRANSCRIPTS: Record<string, unknown[]> = {
  [BOT_CHAT('atlas')]: [
    user('Can you keep an eye on flights to Lisbon for mid December?', at(1, 18, 40)),
    tool('🔎', 'Web Search', 'Lisbon return flights 14–21 Dec', at(1, 18, 40)),
    bot("On it. Cheapest right now is **€212 return** (14–21 Dec, direct). I'll check twice a day and ping you if it drops below €190.", at(1, 18, 41)),
    cronReport(
      'Morning brief',
      `**${todayLabel}**\n\n- ☀️ 17°C and clear, good day for a run before 9\n- 📅 Design review at 11:00, 1:1 with Maya at 16:30\n- ✈️ Lisbon fares dipped to **€198**\n- ✅ Due today: passport photo, reply to Maya, book the dentist`,
      at(0, 8, 0)
    ),
    user('nice. move the dentist to thursday and draft a reply to maya', at(0, 9, 12)),
    tool('📅', 'Calendar Update', 'Dentist → Thu 10:30', at(0, 9, 12)),
    tool('✉️', 'Mail Draft', 'Re: coffee next week?', at(0, 9, 13)),
    bot(
      "Done:\n\n1. Dentist moved to **Thursday, 10:30**, confirmation sent\n2. Draft to Maya saved: short and warm, suggests Friday for coffee\n\nWant me to send it as is?",
      at(0, 9, 13)
    ),
    user('send it 🙌', at(0, 9, 14)),
    bot('Sent ✉️ I also added Friday 10:00 as a tentative hold on your calendar.', at(0, 9, 14))
  ],
  [BOT_CHAT('pixel')]: [
    user('morning! anything for me?', at(0, 10, 2)),
    bot('Morning! The newsletter draft is ready for a last pass, and I left two notes on the hero section.', at(0, 10, 3))
  ],
  [BOT_CHAT('sage')]: [
    user('summarise what we learned about sleep this week', at(1, 22, 10)),
    bot('Three things stood out:\n\n- Consistent wake time matters more than bedtime\n- Morning light within 30 minutes helps\n- Late caffeine has a longer tail than it feels like', at(1, 22, 11))
  ],
  ci: [
    user('The integration tests keep timing out on a cold cache. Can you find out why?', minsAgo(60)),
    tool('🔎', 'Search Files', 'beforeAll|setTimeout in tests/', minsAgo(59)),
    tool('🖥️', 'Terminal', 'pnpm test --filter api -- --runInBand', minsAgo(57)),
    bot(
      "Found it. The suite warms the cache in `beforeAll` but never awaits it, so the first test races the warm-up:\n\n```ts\nbeforeAll(async () => {\n  // was: warmCache()  (fire-and-forget)\n  await warmCache({ timeoutMs: 15_000 })\n})\n\ntest('lists projects', async () => {\n  const res = await api.get('/projects')\n  expect(res.status).toBe(200)\n})\n```\n\nThe fix is one line:\n\n```diff\n- warmCache()\n+ await warmCache({ timeoutMs: 15_000 })\n```\n\nTo reproduce the cold-cache case locally:\n\n```bash\nrm -rf .cache/api && pnpm test --filter api -- --runInBand\n```\n\nTen runs in a row pass with the change.",
      minsAgo(48)
    )
  ],
  hero: [
    user('Give me three hero headline options for a habit tracker app, and compare their tone.', minsAgo(9)),
    tool('🧠', 'Memory Search', 'brand voice notes', minsAgo(9)),
    tool('📄', 'Read File', 'docs/brand-voice.md', minsAgo(9)),
    bot(
      "Here are three directions, all under eight words:\n\n| Headline | Tone | Best for |\n|---|---|---|\n| **Small steps. Every day.** | Calm, encouraging | Broad audience |\n| **Your streak starts now** | Energetic | Fitness-leaning users |\n| **Build habits that stick** | Practical | Productivity crowd |\n\nMy pick is **Small steps. Every day.** It matches the gentle voice in your brand notes and leaves room for a playful subhead:\n\n```text\nSmall steps. Every day.\nTrack habits in 5 seconds, celebrate the streaks that matter.\n```\n\nWant me to mock these up in the hero so you can compare them side by side?",
      minsAgo(6)
    )
  ]
}

const sessionRow = (r: Row) => ({
  session_id: r.id,
  id: r.id,
  title: r.title,
  source: r.source ?? 'desktop',
  started_at: r.last - 3600,
  message_count: r.count,
  model: null,
  running: !!r.running,
  preview: r.preview,
  last_reply: '',
  last_active_at: r.last,
  pinned: !!r.pinned
})

// ─── models ────────────────────────────────────────────────────────────────────────────────────

const PROVIDERS = [
  {
    slug: 'anthropic',
    name: 'Anthropic',
    is_current: true,
    authenticated: true,
    models: ['claude-opus-5.5', 'claude-sonnet-5.5', 'claude-haiku-5.5'],
    capabilities: {
      'claude-opus-5.5': { fast: false, reasoning: true },
      'claude-sonnet-5.5': { fast: false, reasoning: true },
      'claude-haiku-5.5': { fast: false, reasoning: true }
    }
  },
  {
    slug: 'openai-codex',
    name: 'ChatGPT or Codex Subscription',
    is_current: false,
    authenticated: true,
    models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna'],
    capabilities: {
      'gpt-6.1-sol': { fast: true, reasoning: true },
      'gpt-6-sol': { fast: true, reasoning: true },
      'gpt-6-astra': { fast: true, reasoning: true },
      'gpt-6-luna': { fast: true, reasoning: true }
    }
  }
]

const providerOf = (model: string) => (model.startsWith('gpt') ? 'openai-codex' : 'anthropic')

// ─── local state seeding (unread dots, pin order) ──────────────────────────────────────────────

function seedLocalState() {
  try {
    const seen: Record<string, number> = {}
    for (const r of ROWS) seen[`${r.bot}:${r.id}`] = r.last
    for (const b of BOTS) seen[`${b.id}:${BOT_CHAT(b.id)}`] = Date.now() / 1000
    // Something new from Pixel's Bot Chat and in one chat, so the dots show.
    seen[`pixel:${BOT_CHAT('pixel')}`] = at(0, 9, 0)
    seen['pixel:hero'] = minsAgo(30)
    localStorage.setItem('hermes-chan.seen.v1', JSON.stringify(seen))
    localStorage.setItem('hermes-chan.pinOrder.v1', JSON.stringify(['atlas:lisbon', 'pixel:newsletter']))
    localStorage.setItem('hermes-chan.prefs.v1', JSON.stringify({ lastBot: 'atlas', showRoutine: false }))
  } catch {
    /* demo only */
  }
}

// ─── the fake bridge ───────────────────────────────────────────────────────────────────────────

const lastActive = (bot: BotId) => {
  const msgs = TRANSCRIPTS[BOT_CHAT(bot)] as { timestamp: number }[]
  return msgs[msgs.length - 1]!.timestamp
}

const sessionModels = new Map<string, { model: string; effort: string; fast: boolean }>()
const modelFor = (botId: BotId, sid: string) => {
  if (!sessionModels.has(sid)) {
    const m = BOTS.find(b => b.id === botId)!.model
    sessionModels.set(sid, { model: m, effort: 'medium', fast: m.startsWith('gpt') })
  }
  return sessionModels.get(sid)!
}

export function demoBridge(real: HermesBridge): HermesBridge {
  seedLocalState()
  const statuses: BotStatus[] = BOTS.map(b => ({ botId: b.id, state: 'ready' }))

  const request = async (botId: string, method: string, params: Record<string, any> = {}): Promise<any> => {
    const id = botId as BotId
    const b = BOTS.find(x => x.id === id)!
    switch (method) {
      case 'profiles.list':
        return {
          profiles: [
            {
              name: 'default',
              is_default: true,
              display_name: b.name,
              model: b.model,
              description: b.description,
              has_avatar: true,
              ui_meta: { 'hermes-bots': { color: b.color, title: b.name, description: b.description } },
              canonical_session: { id: BOT_CHAT(id), resolved_id: BOT_CHAT(id), title: 'Bot Chat', last_active: lastActive(id) }
            }
          ]
        }
      case 'profiles.get_asset':
        return { data: avatar(b.color, b.emoji) }
      case 'session.list':
        return { sessions: params.scope === 'stored' ? ROWS.filter(r => r.bot === id).map(sessionRow) : [], scope: params.scope ?? 'live' }
      case 'session.resume': {
        const sid = String(params.session_id)
        return {
          session_id: sid,
          messages: TRANSCRIPTS[sid] ?? [user('(demo chat)', minsAgo(60)), bot('This is a demo conversation.', minsAgo(59))],
          info: { title: ROWS.find(r => r.id === sid)?.title ?? 'Bot Chat', running: false },
          running: false,
          revision: 1,
          execution_generation: 1
        }
      }
      case 'session.info': {
        const m = modelFor(id, String(params.session_id))
        return { model: m.model, provider: providerOf(m.model), reasoning_effort: m.effort }
      }
      case 'config.set': {
        const m = modelFor(id, String(params.session_id))
        if (params.key === 'fast') {
          if (params.value !== 'status') m.fast = params.value === 'fast'
          return { key: 'fast', value: m.fast ? 'fast' : 'normal' }
        }
        return {}
      }
      case 'session.mutate': {
        const m = modelFor(id, String(params.session_id))
        if (params.operation === 'model') m.model = params.payload.model
        if (params.operation === 'reasoning') m.effort = params.payload.effort
        return { session_id: params.session_id, operation: params.operation, revision: 2 }
      }
      case 'model.options':
        return { providers: PROVIDERS, model: b.model, provider: providerOf(b.model) }
      default:
        return {}
    }
  }

  return {
    ...real,
    config: async () => ({
      bots: BOTS.map(b => ({ id: b.id, name: b.name, color: b.color, transport: { kind: 'local' as const, profile: 'default' } })),
      hiddenSources: ['cron', 'tool', 'kanban', 'subagent']
    }),
    statuses: async () => statuses,
    request,
    respond: async () => undefined,
    reconnect: async () => undefined,
    setupScanLocal: async () => ({ ok: true, hermes: '/usr/local/bin/hermes', version: 'Hermes Agent (demo)', profiles: ['default', 'research'] }),
    setupScanRemote: async (host: string) => ({ ok: true, hermes: '~/.local/bin/hermes', version: 'Hermes Agent (demo)', profiles: ['default'], ...(host ? {} : {}) }),
    setupSshHosts: async () => ['home-server'],
    setupSave: async () => undefined,
    uploadImage: async (_b, _d, filename) => ({ path: `/demo/${filename}`, mime: 'image/png' }),
    readDataUrl: async () => avatar('hsl(220 20% 30%)', '🖼️'),
    desktopModelPrefs: async () => ({ favorites: ['anthropic::claude-opus-5.5', 'openai-codex::gpt-6.1-sol'], presets: {} }),
    onEvent: () => () => undefined,
    onRequest: () => () => undefined,
    onStatus: () => () => undefined
  }
}
