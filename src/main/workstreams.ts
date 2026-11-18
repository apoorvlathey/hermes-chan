/** A bot's workstreams (W1, W2…), read from the Conduit plugin's registry:
 *  `<profile home>/conduit/workstreams.db`. Read-only, and a bot without the plugin just has none.
 *  The plugin keeps a running workstream's session hidden from session.list, so this is the only
 *  place the app can see them while they work. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { Transport, Workstream } from '../shared/types'
import { sshBase } from './transport'

const run = promisify(execFile)

const QUERY = `SELECT ref, status, session_id, title, goal, progress,
  substr(coalesce(last_result, ''), 1, 600) AS last_result, substr(coalesce(error, ''), 1, 300) AS error,
  created_at, updated_at, closed_at
FROM work WHERE kind = 'workstream'
ORDER BY status IN ('starting','running','needs_you','waiting','ready') DESC, updated_at DESC LIMIT 40`

const PY = `import json,sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
print(json.dumps([dict(r) for r in c.execute(sys.argv[2])]))`

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** sqlite3 when it's there (every Mac, most servers), else the python3 Hermes itself runs on. */
function script(profile: string): string {
  const home = profile === 'default' ? '"$HOME/.hermes"' : `"$HOME/.hermes/profiles/"${shQuote(profile)}`
  return [
    `DB=${home}/conduit/workstreams.db`,
    '[ -f "$DB" ] || { echo "[]"; exit 0; }',
    `if command -v sqlite3 >/dev/null 2>&1; then sqlite3 -readonly -json "$DB" ${shQuote(QUERY)}; echo`,
    `else python3 -c ${shQuote(PY)} "$DB" ${shQuote(QUERY)}; fi`
  ].join('\n')
}

export async function listWorkstreams(t: Transport): Promise<Workstream[]> {
  const sh = script(t.profile)
  const { stdout } =
    t.kind === 'ssh'
      ? await run('ssh', [...sshBase(t.host), `sh -c ${shQuote(sh)}`], { timeout: 20_000 })
      : await run('/bin/sh', ['-c', sh], { timeout: 10_000 })
  const text = stdout.trim()
  const rows = (text ? JSON.parse(text) : []) as Record<string, unknown>[]
  return rows.map(r => {
    let steps: Workstream['steps'] = []
    try {
      const p = JSON.parse(String(r.progress || '{}'))
      if (Array.isArray(p.steps))
        steps = p.steps.map((s: { step?: unknown; state?: unknown }) => ({ step: String(s.step ?? ''), state: String(s.state ?? 'todo') }))
    } catch {
      steps = []
    }
    return {
      ref: String(r.ref),
      status: String(r.status),
      sessionId: String(r.session_id || ''),
      title: String(r.title || r.goal || r.ref),
      steps,
      lastResult: String(r.last_result || ''),
      error: String(r.error || ''),
      createdAt: Number(r.created_at) || 0,
      updatedAt: Number(r.updated_at) || 0,
      closedAt: Number(r.closed_at) || 0
    }
  })
}
