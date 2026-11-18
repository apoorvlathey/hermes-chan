/** Syntax highlighting outside markdown (the tool rows' boxes), with the same highlight.js classes and
 *  colours as fenced code in chat. */
import { common, createLowlight } from 'lowlight'
import type { ReactNode } from 'react'

const lowlight = createLowlight(common)

const EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', jsonl: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', md: 'markdown', html: 'xml', xml: 'xml', svg: 'xml', css: 'css', scss: 'scss',
  sql: 'sql', lua: 'lua', pl: 'perl', r: 'r', graphql: 'graphql', dockerfile: 'dockerfile', makefile: 'makefile'
}

/** highlight.js language for a file path, or undefined. */
export function langForPath(path: string): string | undefined {
  const base = path.split('/').pop()?.toLowerCase() ?? ''
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'makefile'
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  return EXT[ext]
}

/** Text that is a JSON object or array, re-indented; null when it isn't JSON. */
export function prettyJson(text: string): string | null {
  const t = text.trim()
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) return null
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return null
  }
}

/** The slice of a hast tree lowlight returns: text and spans with classes. */
type Node = { type: string; value?: string; properties?: { className?: unknown }; children?: Node[] }

function render(nodes: Node[], key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === 'text') return n.value ?? ''
    if (n.type === 'element') {
      const el = n
      const cls = el.properties?.className
      return (
        <span key={key + i} className={Array.isArray(cls) ? cls.join(' ') : String(cls ?? '')}>
          {render(el.children ?? [], `${key}${i}.`)}
        </span>
      )
    }
    return null
  })
}

/** `text` highlighted as `lang` (a highlight.js name); plain text when the language is unknown. */
export function Highlighted({ text, lang }: { text: string; lang?: string }) {
  if (!lang || !lowlight.registered(lang)) return <>{text}</>
  try {
    return <>{render(lowlight.highlight(lang, text).children as Node[])}</>
  } catch {
    return <>{text}</>
  }
}
