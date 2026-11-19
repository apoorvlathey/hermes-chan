/** Demo mode (`pnpm demo`): a fake Hermes backend with made-up bots, chats and models, so the UI can
 *  be shown or screenshotted without connecting to any gateway or exposing real history. The main
 *  process starts no connections and uses a separate userData folder in this mode. */
import type { BotStatus, HermesBridge, Workstream } from '../../shared/types'

export const IS_DEMO = new URLSearchParams(location.search).has('demo')
/** `?demo=onboarding`: no bots yet, so the app opens on its first-run setup screen. */
const ONBOARDING = new URLSearchParams(location.search).get('demo') === 'onboarding'

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

// ─── workstreams (the Conduit plugin's background tasks) ─────────────────────────────────────────

const step = (step: string, state: 'done' | 'doing' | 'todo') => ({ step, state })
const work = (ref: string, status: string, title: string, steps: { step: string; state: string }[], updated: number, closed = 0): Workstream => ({
  ref, status, title, steps, sessionId: `work-${ref.toLowerCase()}`, lastResult: '', error: '', createdAt: updated - 1800, updatedAt: updated, closedAt: closed
})
// W3 shows a resolved one: Conduit closes a workstream without changing its "ready" status.
const WORKSTREAMS: Partial<Record<string, Workstream[]>> = {
  atlas: [
    work('W7', 'running', 'Book the Lisbon flights and a quiet stay near Alfama', [step('Compare fares for the 14th', 'done'), step('Shortlist three guesthouses', 'doing'), step('Hold the best pair', 'todo'), step('Send the summary', 'todo')], minsAgo(4)),
    work('W6', 'ready', 'Draft the Q3 board update from the metrics sheet', [step('Pull the numbers', 'done'), step('Write the narrative', 'done'), step('Check every figure', 'done')], minsAgo(35)),
    work('W5', 'waiting', 'Get Pixel to refresh the deck cover', [step('Brief Pixel', 'done'), step('Review the options', 'todo')], minsAgo(52)),
    work('W4', 'done', 'Fix the flaky integration tests on the api repo', [], minsAgo(180), minsAgo(170)),
    work('W3', 'ready', 'Renew the domain and move DNS to the new host', [], at(1, 16, 20), at(1, 16, 40)),
    work('W2', 'failed', 'Export last year\'s receipts to the accountant folder', [], at(2, 10, 5), at(2, 10, 9)),
    work('W1', 'done', 'Summarise the inbox backlog by sender', [], at(3, 9, 0), at(3, 9, 30))
  ]
}
WORKSTREAMS.atlas![5]!.error = 'The accountant folder is read-only'

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
/** A built-in tool call as Hermes stores it: name, args and the gateway's short preview. */
const call = (name: string, args: Record<string, unknown>, ts: number, result?: unknown) => ({
  role: 'tool',
  name,
  args,
  ...(result !== undefined ? { content: JSON.stringify(result) } : {}),
  context: String(Object.values(args)[0] ?? '').slice(0, 80),
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

const cronOutput = (job: string, text: string, ts: number) => ({
  role: 'user',
  display_kind: 'internal_notification',
  text: `[Cronjob "[bot:default] ${job}" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\n${text}`,
  timestamp: ts
})

// Hermes's async-delegation report: the whole task source for the model, a short title for people.
const subagentDone = (goal: string, result: string, ts: number) => ({
  role: 'user',
  display_kind: 'async_delegation_complete',
  display_metadata: { display_text: `Subagent Task Completed: ${goal}`, task_count: 1 },
  text: `[ASYNC DELEGATION COMPLETE — deleg_3f9a21c0]\nA background subagent you dispatched earlier has finished. You may have moved on since dispatching it; the full task source is below so you can act on the result or re-dispatch if things have changed.\n\nDispatched: 2026-11-19 09:15:02 (48s ago)\nOriginal goal: ${goal}\nRole: leaf   Model: claude-sonnet-5.5\nStatus: completed   API calls: 6   Duration: 47.9s\n--- RESULT ---\n${result}`,
  timestamp: ts
})

const todayLabel = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })

// A workstream as the Conduit plugin writes it: the coordinator's brief opens it, follow-ups arrive
// as steer rows. The plugin's standing instructions to the worker are part of the brief's text.
const brief = (from: string, ref: string, title: string, said: string, task: string, ts: number) =>
  user(
    `You're working on a task for ${from}, who coordinates the user's work in their Bot Chat. This chat is that workstream (${ref}: ${title}); the user can open it and talk to you here. Do the task with your own tools.\n\nIf a step needs the user on ${from}'s screen, call work_progress with screen set.\n\nThe user's message that ${from} is answering now, as they wrote it (this is the user speaking; ${from}'s own words are ${from}'s):\n«${said}»\n\nTask:\n${task}`,
    ts
  )
const followUp = (from: string, text: string, said: string, ts: number) => ({
  role: 'user',
  display_kind: 'steer',
  text: `[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position]\n${from}, who coordinates this work, passes on:\n${text}\n\nThe user's message that ${from} is answering now, as they wrote it (this is the user speaking; ${from}'s own words are ${from}'s):\n«${said}»\n[/OUT-OF-BAND USER MESSAGE]`,
  timestamp: ts
})

const TRANSCRIPTS: Record<string, unknown[]> = {
  'work-w7': [
    brief(
      'Atlas',
      'W7',
      'Book the Lisbon flights and a quiet stay near Alfama',
      "fares dipped, let's book lisbon for 14–21 dec and find somewhere quiet near alfama",
      'Book the cheapest direct return to Lisbon for 14–21 December (fares were €198 this morning) and shortlist three quiet guesthouses within a 10-minute walk of Alfama, under €140 a night with good reviews for noise. Hold the best flight and stay pair if the airline and sites allow a free hold; do not pay for anything. Report the options with prices, cancellation terms and links, and say which pair you would pick and why. Keep the passport details out of any form until the user confirms.',
      minsAgo(40)
    ),
    tool('🔎', 'Web Search', 'Lisbon direct flights 14–21 Dec', minsAgo(39)),
    tool('🌐', 'Browser', 'TAP fare calendar', minsAgo(38)),
    bot('Flights first: **TAP direct, €198 return**, 14 Dec 09:40 → 21 Dec 18:15. Free 24-hour hold is available, so I placed one. Now looking at guesthouses.', minsAgo(30)),
    followUp('Atlas', 'The user prefers a place with a small kitchen, even if it costs a little more. Keep the €140 cap unless one is clearly better.', 'oh and a kitchenette would be nice', minsAgo(12)),
    tool('🔎', 'Web Search', 'Alfama guesthouse kitchenette quiet', minsAgo(11)),
    bot('Noted, kitchenette it is. Two of the three shortlisted places have one; swapping the third for **Casa do Largo** (€132, quiet courtyard room).', minsAgo(4))
  ],
  [BOT_CHAT('atlas')]: [
    user('Can you keep an eye on flights to Lisbon for mid December?', at(1, 18, 40)),
    tool('🔎', 'Web Search', 'Lisbon return flights 14–21 Dec', at(1, 18, 40)),
    bot("On it. Cheapest right now is **€212 return** (14–21 Dec, direct). I'll check twice a day and ping you if it drops below €190.", at(1, 18, 41)),
    cronReport(
      'Morning brief',
      `**${todayLabel}**\n\n- ☀️ 17°C and clear, good day for a run before 9\n- 📅 Design review at 11:00, 1:1 with Maya at 16:30\n- ✈️ Lisbon fares dipped to **€198**\n- ✅ Due today: passport photo, reply to Maya, book the dentist`,
      at(0, 8, 0)
    ),
    cronOutput(
      'Fare watch',
      '## Lisbon fares | 14–21 Dec\n\n**Cheapest:** €198 return, direct, down from €212.\n\n### Options\n\n| Carrier | Out | Back | Price |\n|---|---|---|---|\n| TAP | 07:10 | 19:40 | €198 |\n| easyJet | 11:25 | 21:05 | €204 |\n| BA | 08:00 | 17:55 | €231 |\n\nThreshold is €190, so no alert sent.',
      at(0, 8, 30)
    ),
    bot('Lisbon fares dipped to **€198** this morning, still above your €190 alert line. Nothing to do yet.', at(0, 8, 31)),
    user('nice. move the dentist to thursday and draft a reply to maya', at(0, 9, 12)),
    tool('📅', 'Calendar Update', 'Dentist → Thu 10:30', at(0, 9, 12)),
    tool('✉️', 'Mail Draft', 'Re: coffee next week?', at(0, 9, 13)),
    bot(
      "Done:\n\n1. Dentist moved to **Thursday, 10:30**, confirmation sent\n2. Draft to Maya saved: short and warm, suggests Friday for coffee\n\nWant me to send it as is?",
      at(0, 9, 13)
    ),
    user('send it 🙌', at(0, 9, 14)),
    bot('Sent ✉️ I also added Friday 10:00 as a tentative hold on your calendar. Checking guesthouses near Alfama in the background.', at(0, 9, 14)),
    subagentDone(
      'Shortlist three quiet guesthouses near Alfama for 14–21 Dec under €120/night, with recent reviews',
      '**Three options, all with free cancellation:**\n\n| Guesthouse | Per night | Rating | Note |\n|---|---|---|---|\n| Casa do Largo | €104 | 9.1 | Courtyard rooms are the quiet ones |\n| Alfama Patio | €96 | 8.8 | 4 min to the tram, no lift |\n| Memória Hostel (private) | €82 | 9.3 | Shared kitchen |\n\nCasa do Largo is the best match for quiet; recent reviews mention thick walls and no street noise.',
      at(0, 9, 15)
    ),
    bot('Shortlist is in. **Casa do Largo** (€104/night) fits best: courtyard rooms, quiet. Want me to hold it?', at(0, 9, 16))
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
    call('search_files', { pattern: 'beforeAll|setTimeout', path: 'tests/' }, minsAgo(59)),
    call('read_file', { path: '/home/dev/projects/api/tests/setup/cache.ts' }, minsAgo(59)),
    call('read_file', { path: '/home/dev/projects/api/tests/integration/projects.test.ts' }, minsAgo(58)),
    call('read_file', { path: '/home/dev/projects/api/jest.config.ts' }, minsAgo(58)),
    call(
      'terminal',
      { command: 'rm -rf .cache/api && pnpm test --filter api -- --runInBand --testTimeout=30000 2>&1 | tail -40' },
      minsAgo(57),
      {
        output:
          "FAIL tests/integration/projects.test.ts\n  ● lists projects\n\n    thrown: \"Exceeded timeout of 5000 ms for a test.\"\n\n      at tests/integration/projects.test.ts:9:1\n\nTests: 1 failed, 23 passed, 24 total\nTime:  41.2 s",
        exit_code: 1,
        error: null
      }
    ),
    call('terminal', { command: 'git log --oneline -5 -- tests/setup/cache.ts' }, minsAgo(56), {
      output: 'a41c9e2 Warm the API cache once per suite\n7be0d13 Move test setup into tests/setup',
      exit_code: 0,
      error: null
    }),
    call(
      'patch',
      { mode: 'replace', path: '/home/dev/projects/api/tests/setup/cache.ts', old_string: '  warmCache()', new_string: '  await warmCache({ timeoutMs: 15_000 })' },
      minsAgo(54),
      {
        success: true,
        diff: "--- a/tests/setup/cache.ts\n+++ b/tests/setup/cache.ts\n@@ -3,5 +3,5 @@ import { warmCache } from '../../src/cache'\n \n beforeAll(async () => {\n-  warmCache()\n+  await warmCache({ timeoutMs: 15_000 })\n })"
      }
    ),
    call('terminal', { command: 'for i in $(seq 1 10); do rm -rf .cache/api && pnpm test --filter api -- --runInBand || exit 1; done' }, minsAgo(53), {
      output: 'Tests: 24 passed, 24 total (×10)\nTime:  38.9 s average',
      exit_code: 0,
      error: null
    }),
    call('web_search', { query: 'jest beforeAll async not awaited cold cache' }, minsAgo(50)),
    call('terminal', { command: 'pnpm lint --filter api' }, minsAgo(49), { output: 'No problems found.', exit_code: 0, error: null }),
    call('terminal', { command: "node -e 'console.log(JSON.stringify(require(\"./package.json\").scripts))'" }, minsAgo(49), {
      output: '{"test":"jest","lint":"eslint . --max-warnings 0","build":"tsc -p tsconfig.build.json","ci":"pnpm lint && pnpm test --runInBand"}',
      exit_code: 0,
      error: null
    }),
    call('memory', { action: 'add', target: 'project', content: 'api tests: warm the cache with await in beforeAll; cold runs take ~40s', tags: ['ci', 'api'], ttl_days: 90 }, minsAgo(48), {
      success: true,
      id: 'mem_2f81',
      stored: { target: 'project', tags: ['ci', 'api'], expires: '2027-02-16' }
    }),
    call('terminal', { command: 'git diff --stat' }, minsAgo(49), { output: ' tests/setup/cache.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)', exit_code: 0, error: null }),
    bot(
      "Found it. The suite warms the cache in `beforeAll` but never awaits it, so the first test races the warm-up:\n\n```ts\nbeforeAll(async () => {\n  // was: warmCache()  (fire-and-forget)\n  await warmCache({ timeoutMs: 15_000 })\n})\n\ntest('lists projects', async () => {\n  const res = await api.get('/projects')\n  expect(res.status).toBe(200)\n})\n```\n\nThe fix is one line:\n\n```diff\n- warmCache()\n+ await warmCache({ timeoutMs: 15_000 })\n```\n\nTo reproduce the cold-cache case locally:\n\n```bash\nrm -rf .cache/api && pnpm test --filter api -- --runInBand\n```\n\nTen runs in a row pass with the change.",
      minsAgo(48)
    )
  ],
  hero: [
    user('Give me three hero headline options for a habit tracker app, and compare their tone.', minsAgo(9)),
    tool('🧠', 'Memory Search', 'brand voice notes', minsAgo(9)),
    call('read_file', { path: 'docs/brand-voice.md' }, minsAgo(9)),
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

  const DEMO_COMMANDS = {
    categories: [
      { name: 'Session', pairs: [
        ['/new', 'Start a new session'], ['/retry', 'Retry the last message (resend to agent)'], ['/undo', 'Back up N user turns and re-prompt (default 1)'],
        ['/title', 'Set a title for the current session'], ['/compress', 'Compress conversation context'], ['/stop', 'Kill all running background processes'],
        ['/queue', 'Queue a prompt for after the current turn'], ['/goal', 'Set a standing goal the agent works toward'], ['/plan', 'Plan before acting'],
        ['/status', 'Show session, model, token, and context info'], ['/context', 'Show detailed context window view']
      ] },
      { name: 'Configuration', pairs: [['/reasoning', 'Manage reasoning effort and display'], ['/personality', 'Set a predefined personality'], ['/clear', 'Clear screen and start a new session']] },
      { name: 'Info', pairs: [['/usage', 'Show token usage and account limits'], ['/insights', 'Usage insights'], ['/help', 'Show available commands']] },
      { name: 'Tools & Skills', pairs: [['/tools', 'Manage tools'], ['/skills', 'Search, install, inspect, or manage skills'], ['/memory', 'View or edit memory'], ['/cron', 'Manage scheduled jobs']] },
      { name: 'Skills', pairs: [['/flight-search', 'Search fares across airlines and flexible dates.'], ['/recipe-scaler', 'Scale a recipe and its shopping list.'], ['/weekly-review', 'Run the weekly review checklist.']] }
    ],
    commands: {
      '/new': { argument_mode: 'text', desktop: null }, '/retry': { argument_mode: null, desktop: null }, '/undo': { argument_mode: 'text', desktop: null },
      '/title': { argument_mode: 'text', desktop: null }, '/compress': { argument_mode: 'text', desktop: null }, '/stop': { argument_mode: null, desktop: null },
      '/queue': { argument_mode: 'mixed', desktop: null }, '/goal': { argument_mode: 'mixed', desktop: null }, '/plan': { argument_mode: 'text', desktop: null },
      '/status': { argument_mode: null, desktop: null }, '/context': { argument_mode: 'options', desktop: null }, '/reasoning': { argument_mode: 'options', desktop: null },
      '/personality': { argument_mode: 'options', desktop: null }, '/clear': { argument_mode: null, desktop: 'terminal' }, '/usage': { argument_mode: 'text', desktop: null },
      '/insights': { argument_mode: 'text', desktop: 'advanced' }, '/help': { argument_mode: 'text', desktop: null }, '/tools': { argument_mode: 'options', desktop: null },
      '/skills': { argument_mode: 'options', desktop: null }, '/memory': { argument_mode: 'options', desktop: null }, '/cron': { argument_mode: 'options', desktop: 'terminal' }
    },
    skills: { '/flight-search': { usage: 3, origin: 'user' }, '/recipe-scaler': { usage: 1, origin: 'user' }, '/weekly-review': { usage: 5, origin: 'user' } },
    canon: { '/reset': '/new' }
  }

  const demoCommandOutput = (name: string, model: string, cmd: string) =>
    cmd.startsWith('status')
      ? `📊 **${name} status**\n\n**Title:** Bot Chat\n**Model:** \`${model}\`\n**Context:** 18,240 / 400,000 (5%)\n**Agent Running:** No`
      : `/${cmd}: done`

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
        // A short, realistic wait so the loading skeleton shows; `localStorage['hermes-chan.demoLatency']`
        // (ms) holds it longer for screenshots.
        await new Promise(r => setTimeout(r, Number(localStorage.getItem('hermes-chan.demoLatency')) || 300))
        return {
          session_id: sid,
          messages: TRANSCRIPTS[sid] ?? [user('(demo chat)', minsAgo(60)), bot('This is a demo conversation.', minsAgo(59))],
          info: { title: ROWS.find(r => r.id === sid)?.title ?? Object.values(WORKSTREAMS).flat().find(w => w?.sessionId === sid)?.title ?? 'Bot Chat', running: false },
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
      case 'commands.catalog':
        return DEMO_COMMANDS
      case 'complete.slash': {
        const m = /^\/reasoning\s+(\S*)$/.exec(String(params.text ?? ''))
        if (!m) return { items: [] }
        const items = ['low', 'medium', 'high', 'xhigh'].filter(x => x.startsWith(m[1])).map(text => ({ text, display: text, meta: '' }))
        return { items, replace_from: String(params.text).length - m[1].length }
      }
      case 'slash.exec':
        return { output: demoCommandOutput(b.name, b.model, String(params.command ?? '')) }
      default:
        return {}
    }
  }

  return {
    ...real,
    config: async () => ONBOARDING ? { bots: [], hiddenSources: ['cron', 'tool', 'kanban', 'subagent'] } : ({
      bots: BOTS.map(b => ({ id: b.id, name: b.name, color: b.color, transport: { kind: 'local' as const, profile: 'default' } })),
      hiddenSources: ['cron', 'tool', 'kanban', 'subagent']
    }),
    statuses: async () => statuses,
    request,
    respond: async () => undefined,
    reconnect: async () => undefined,
    setupScanLocal: async () => {
      await new Promise(r => setTimeout(r, 700))
      return { ok: true, hermes: '/usr/local/bin/hermes', version: 'Hermes Agent v0.23.1', profiles: ['default', 'research', 'writing'] }
    },
    setupScanRemote: async (host: string) => {
      await new Promise(r => setTimeout(r, 900))
      return host === 'home-server'
        ? { ok: true, hermes: '~/.local/bin/hermes', version: 'Hermes Agent v0.23.1', profiles: ['default', 'ops'] }
        : { ok: false, hermes: null, version: null, profiles: [], error: 'SSH key was refused', hint: 'Add your SSH key to the server once, then retry.', command: `ssh-copy-id ${host}` }
    },
    setupSshHosts: async () => ['home-server', 'build-box'],
    setupSave: async () => undefined,
    reorderBots: async () => undefined,
    uploadImage: async (_b, _d, filename) => ({ path: `/demo/${filename}`, mime: 'image/png' }),
    readDataUrl: async () => avatar('hsl(220 20% 30%)', '🖼️'),
    workstreams: async botId => WORKSTREAMS[botId] ?? [],
    desktopModelPrefs: async () => ({ favorites: ['anthropic::claude-opus-5.5', 'openai-codex::gpt-6.1-sol'], presets: {} }),
    onEvent: () => () => undefined,
    onRequest: () => () => undefined,
    onStatus: () => () => undefined
  }
}
