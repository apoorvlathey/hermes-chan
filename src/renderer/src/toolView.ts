/** How a tool call reads in the chat: a kind (for the icon), a verb ("Ran", "Edited") and the one thing it
 *  acted on (a command, a file, a query). Built from the tool's name and arguments, since Hermes only phrases
 *  connector tools itself and sends the rest as a bare name plus an 80-character preview. */
import { langForPath, prettyJson } from './highlight'
import { prettyTool, type ToolInfo } from './store'

export type ToolKind = 'run' | 'edit' | 'read' | 'search' | 'web' | 'browser' | 'memory' | 'agent' | 'image' | 'todo' | 'skill' | 'other'

/** One block of the opened row: the call's input, the edit it made, or what it printed. */
export interface ToolSection {
  label: string
  text: string
  kind: 'code' | 'diff' | 'text'
  /** highlight.js language for a code box; JSON is detected on its own. */
  lang?: string
  /** Shown in the danger colour (an error, a non-zero exit). */
  bad?: boolean
}

export interface ToolView {
  kind: ToolKind
  verb: string
  /** One line: a command, a path, a query. */
  detail: string
  /** The detail is a file path: shown as file name plus folder. */
  path?: boolean
  /** The detail is code or a command: shown in monospace. */
  mono?: boolean
  /** Everything worth reading when the row is opened. */
  sections: ToolSection[]
  /** The call failed (error field, success false, non-zero exit). */
  failed?: boolean
  /** Connector tools bring their own emoji. */
  emoji?: string
}

const KNOWN: Record<string, { kind: ToolKind; verb: string }> = {
  terminal: { kind: 'run', verb: 'Ran' },
  process: { kind: 'run', verb: 'Checked process' },
  execute_code: { kind: 'run', verb: 'Ran code' },
  read_file: { kind: 'read', verb: 'Read' },
  write_file: { kind: 'edit', verb: 'Wrote' },
  patch: { kind: 'edit', verb: 'Edited' },
  search_files: { kind: 'search', verb: 'Searched' },
  session_search: { kind: 'search', verb: 'Searched past chats' },
  web_search: { kind: 'web', verb: 'Searched the web' },
  web_extract: { kind: 'web', verb: 'Read page' },
  browser_navigate: { kind: 'browser', verb: 'Opened' },
  browser_click: { kind: 'browser', verb: 'Clicked' },
  browser_type: { kind: 'browser', verb: 'Typed' },
  browser_snapshot: { kind: 'browser', verb: 'Looked at page' },
  browser_scroll: { kind: 'browser', verb: 'Scrolled' },
  vision_analyze: { kind: 'image', verb: 'Looked at image' },
  image_generate: { kind: 'image', verb: 'Made image' },
  video_generate: { kind: 'image', verb: 'Made video' },
  text_to_speech: { kind: 'other', verb: 'Spoke' },
  memory: { kind: 'memory', verb: 'Memory' },
  todo_list: { kind: 'todo', verb: 'Updated to-dos' },
  todo: { kind: 'todo', verb: 'Updated to-dos' },
  delegate_task: { kind: 'agent', verb: 'Delegated' },
  skill_view: { kind: 'skill', verb: 'Read skill' },
  skills_list: { kind: 'skill', verb: 'Listed skills' },
  skill_manage: { kind: 'skill', verb: 'Updated skill' },
  cronjob_manage: { kind: 'todo', verb: 'Scheduled' },
  cronjob: { kind: 'todo', verb: 'Scheduled' },
  clarify: { kind: 'other', verb: 'Asked you' }
}

const LIMIT = 6000
const clip = (s: string) => (s.length > LIMIT ? `${s.slice(0, LIMIT)}\n… (${(s.length - LIMIT).toLocaleString()} more characters)` : s)
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')
const firstLine = (s: string) => s.split('\n').find(l => l.trim())?.trim() ?? ''
const pick = (a: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) {
    const v = str(a[k]).trim()
    if (v) return v
  }
  return ''
}
const json = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '')

/** File paths named in a V4A patch ("*** Update File: x"). */
function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(m => m[1]!.trim())
}

/** A replace-mode edit as a small diff, for when the stored result has none. */
function replaceDiff(oldS: string, newS: string): string {
  const side = (t: string, mark: string) => t.split('\n').map(l => `${mark}${l}`).join('\n')
  return `${side(oldS, '-')}\n${side(newS, '+')}`
}

function skillOps(a: Record<string, unknown>): Record<string, unknown>[] {
  let ops = a.operations
  if (typeof ops === 'string') {
    try {
      ops = JSON.parse(ops)
    } catch {
      return []
    }
  }
  return Array.isArray(ops) ? ops.filter((o): o is Record<string, unknown> => !!o && typeof o === 'object') : []
}

/** What came back, as sections: output and errors for commands, the diff for edits, otherwise the payload. */
function resultSections(name: string, r: unknown, langFor?: string): { sections: ToolSection[]; failed: boolean } {
  if (r === undefined || r === null || r === '') return { sections: [], failed: false }
  if (typeof r !== 'object') return { sections: [{ label: 'Result', text: String(r), kind: 'code' }], failed: false }
  const o = r as Record<string, unknown>
  const error = str(o.error).trim()
  const exit = typeof o.exit_code === 'number' ? o.exit_code : undefined
  const failed = !!error || o.success === false || o.ok === false || (exit !== undefined && exit !== 0)
  const out: ToolSection[] = []
  if (typeof o.diff === 'string' && o.diff.trim()) out.push({ label: 'Changes', text: clip(o.diff.trim()), kind: 'diff' })
  if (typeof o.output === 'string') {
    const label = exit !== undefined ? `Output · exit ${exit}` : 'Output'
    out.push({ label, text: o.output.trim() || '(no output)', kind: 'code', bad: exit !== undefined && exit !== 0 })
  } else if (typeof o.content === 'string' && name === 'read_file') {
    out.push({ label: 'Contents', text: o.content, kind: 'code', lang: langFor })
  }
  if (error) out.push({ label: 'Error', text: clip(error), kind: 'text', bad: true })
  if (!out.length) {
    const rest = Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'success' && k !== 'error'))
    if (Object.keys(rest).length) out.push({ label: 'Result', text: json(rest), kind: 'code', lang: 'json' })
  }
  return { sections: out, failed }
}

export function describeTool(t: ToolInfo): ToolView {
  const a = t.args ?? {}
  const hasArgs = Object.keys(a).length > 0
  const known = KNOWN[t.name]
  const res = resultSections(t.name, t.result, langForPath(pick(a, 'path', 'file_path')))
  const input: ToolSection[] = []
  let view: Omit<ToolView, 'sections'>

  if (!known) {
    // Connector and MCP tools: Hermes phrases them ("Gmail · send email"); otherwise the tool's own name.
    const phrased = t.label && t.label !== t.context ? t.label : prettyTool(t.name)
    const detail = t.preview || (t.context && t.context !== phrased ? t.context : '')
    view = { kind: 'other', verb: phrased, detail: firstLine(detail), emoji: t.emoji }
    if (hasArgs) input.push({ label: 'Input', text: json(a), kind: 'code', lang: 'json' })
  } else {
    const { kind, verb } = known
    switch (t.name) {
      case 'terminal': {
        const cmd = pick(a, 'command', 'cmd') || t.context || ''
        view = { kind, verb, detail: firstLine(cmd), mono: true }
        if (cmd) input.push({ label: 'Command', text: cmd, kind: 'code', lang: 'bash' })
        const wd = pick(a, 'workdir', 'cwd')
        if (wd) input.push({ label: 'In', text: wd, kind: 'code' })
        break
      }
      case 'execute_code': {
        const code = pick(a, 'code', 'script') || t.context || ''
        view = { kind, verb, detail: firstLine(code), mono: true }
        if (code) input.push({ label: 'Code', text: code, kind: 'code', lang: str(a.language).toLowerCase() || 'python' })
        break
      }
      case 'patch': {
        const v4a = pick(a, 'patch')
        const files = v4a ? patchFiles(v4a) : []
        const path = pick(a, 'path', 'file_path') || files[0] || t.context || ''
        view = { kind, verb, detail: path, path: !!path }
        if (path) input.push({ label: files.length > 1 ? 'Files' : 'File', text: files.length > 1 ? files.join('\n') : path, kind: 'code' })
        if (!res.sections.some(s => s.kind === 'diff')) {
          if (v4a) input.push({ label: 'Patch', text: clip(v4a), kind: 'diff' })
          else if ('old_string' in a || 'new_string' in a)
            input.push({ label: a.replace_all ? 'Changes · every match' : 'Changes', text: clip(replaceDiff(str(a.old_string), str(a.new_string))), kind: 'diff' })
        }
        break
      }
      case 'read_file':
      case 'write_file': {
        const path = pick(a, 'path', 'file_path', 'filename') || t.context || ''
        view = { kind, verb, detail: path, path: !!path }
        if (path) input.push({ label: 'File', text: path + (a.offset ? ` (from line ${str(a.offset)})` : ''), kind: 'code' })
        if (t.name === 'write_file' && typeof a.content === 'string' && !res.sections.length) input.push({ label: 'Content', text: a.content, kind: 'code', lang: langForPath(path) })
        break
      }
      case 'skill_manage': {
        const ops = skillOps(a)
        const name = pick(a, 'name', 'skill')
        const first = ops[0] ?? {}
        const target = name || pick(first, 'name', 'skill', 'file_path')
        const action = pick(first, 'action')
        view = { kind, verb: action === 'create' ? 'Created skill' : verb, detail: target, mono: !name && !!target }
        if (hasArgs) input.push({ label: ops.length > 1 ? `${ops.length} changes` : 'Change', text: json(ops.length ? ops : a), kind: 'code', lang: 'json' })
        break
      }
      case 'search_files': {
        const q = pick(a, 'pattern', 'query', 'regex') || t.context || ''
        const where = pick(a, 'path', 'directory')
        view = { kind, verb, detail: q, mono: true }
        if (q) input.push({ label: 'Pattern', text: q, kind: 'code' })
        if (where) input.push({ label: 'In', text: where, kind: 'code' })
        break
      }
      case 'web_extract':
      case 'browser_navigate': {
        const urls = Array.isArray(a.urls) ? a.urls.map(str).filter(Boolean) : []
        const url = pick(a, 'url') || urls[0] || t.context || ''
        view = { kind, verb, detail: url.replace(/^https?:\/\/(www\.)?/, '') }
        if (url) input.push({ label: urls.length > 1 ? 'Pages' : 'Page', text: urls.length > 1 ? urls.join('\n') : url, kind: 'code' })
        break
      }
      case 'delegate_task': {
        const goal = pick(a, 'goal', 'task', 'prompt') || t.context || ''
        view = { kind, verb, detail: firstLine(goal) }
        if (goal) input.push({ label: 'Task', text: clip(goal), kind: 'text' })
        break
      }
      default: {
        const detail = pick(a, 'query', 'text', 'name', 'action') || t.preview || (t.context && t.context !== t.label ? t.context : '') || ''
        view = { kind, verb, detail: firstLine(detail) }
        if (hasArgs) input.push({ label: 'Input', text: json(a), kind: 'code', lang: 'json' })
        else if (detail) input.push({ label: 'Input', text: detail, kind: 'text' })
      }
    }
  }
  if (!hasArgs && !input.length && t.context) input.push({ label: 'Input', text: t.context, kind: 'code' })
  return { ...view, sections: [...input, ...res.sections].map(polish), failed: res.failed }
}

/** JSON anywhere (an output, a result, a string argument) is re-indented and highlighted; then long
 *  boxes are clipped. */
function polish(sec: ToolSection): ToolSection {
  if (sec.kind === 'diff') return { ...sec, text: clip(sec.text) }
  const pretty = (!sec.lang || sec.lang === 'json') && prettyJson(sec.text)
  if (pretty) return { ...sec, kind: 'code', text: clip(pretty), lang: 'json' }
  return { ...sec, text: clip(sec.text) }
}

const NOUNS: Partial<Record<ToolKind, [string, string]>> = {
  run: ['command', 'commands'],
  edit: ['edit', 'edits'],
  read: ['file read', 'files read'],
  search: ['search', 'searches'],
  web: ['web lookup', 'web lookups'],
  browser: ['browser step', 'browser steps']
}

/** "6 commands · 3 edits · 2 files read": the biggest kinds, for the collapsed pill. */
export function summarize(views: ToolView[]): string {
  const counts = new Map<ToolKind, number>()
  for (const v of views) if (NOUNS[v.kind]) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1)
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([k, n]) => `${n} ${NOUNS[k]![n === 1 ? 0 : 1]}`)
    .join(' · ')
}

/** "/home/me/project/src/app.ts" → { name: "app.ts", dir: "…/project/src" } */
export function splitPath(p: string): { name: string; dir: string } {
  const clean = p.replace(/\/+$/, '')
  const at = clean.lastIndexOf('/')
  if (at < 0) return { name: clean, dir: '' }
  const dir = clean.slice(0, at)
  const parts = dir.split('/').filter(Boolean)
  return { name: clean.slice(at + 1), dir: parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : dir || '/' }
}
