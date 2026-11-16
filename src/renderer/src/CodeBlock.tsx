/** Fenced code in markdown: a header with the language and a copy button, highlighted by
 *  rehype-highlight (highlight.js classes, coloured in styles.css for light and dark). */
import { type ReactNode, useRef, useState } from 'react'

const LANG_NAMES: Record<string, string> = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  py: 'Python',
  python: 'Python',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  shell: 'Shell',
  console: 'Console',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  md: 'Markdown',
  markdown: 'Markdown',
  html: 'HTML',
  xml: 'XML',
  css: 'CSS',
  scss: 'SCSS',
  sql: 'SQL',
  rust: 'Rust',
  rs: 'Rust',
  go: 'Go',
  sol: 'Solidity',
  solidity: 'Solidity',
  diff: 'Diff',
  text: 'Text',
  plaintext: 'Text'
}

/** The fence's language, from the `language-xyz` class markdown puts on the inner <code>. */
function languageOf(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children
  const cls = (child as { props?: { className?: string } } | null)?.props?.className ?? ''
  return /language-([\w+#-]+)/.exec(cls)?.[1]?.toLowerCase() ?? null
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Fallback for contexts without the async clipboard API.
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

export function CodeBlock({ children }: { children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const lang = languageOf(children)
  const label = lang ? (LANG_NAMES[lang] ?? lang) : null

  const copy = async () => {
    const text = pre.current?.innerText.replace(/\n$/, '') ?? ''
    await copyText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{label}</span>
        <button className={`code-copy ${copied ? 'done' : ''}`} onClick={() => void copy()} title="Copy code" aria-label="Copy code">
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={pre}>{children}</pre>
    </div>
  )
}
