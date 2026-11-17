/** Probes behind the in-app setup flow: find Hermes on this Mac or on an SSH host, list its
 *  profiles, and suggest hosts from ~/.ssh/config. Nothing here changes Hermes or the server. */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { SetupScan } from '../shared/types'
import { friendlyError } from './bots'
import { sshBase } from './transport'

const run = promisify(execFile)

/** One POSIX-sh probe for both sides: where `hermes` is, its version, and the profiles on disk
 *  (~/.hermes is "default"; each ~/.hermes/profiles/<name> is another profile). */
const PROBE = `
H=$(command -v hermes 2>/dev/null)
[ -z "$H" ] && [ -x "$HOME/.local/bin/hermes" ] && H="$HOME/.local/bin/hermes"
echo "HERMES=$H"
[ -n "$H" ] && "$H" --version 2>/dev/null | head -1 | sed 's/^/VERSION=/'
[ -d "$HOME/.hermes" ] && [ -f "$HOME/.hermes/config.yaml" ] && echo "PROFILE=default"
for d in "$HOME"/.hermes/profiles/*/; do [ -d "$d" ] && echo "PROFILE=$(basename "$d")"; done
exit 0
`

function parseProbe(out: string): Omit<SetupScan, 'ok' | 'error' | 'hint'> {
  let hermes: string | null = null
  let version: string | null = null
  const profiles: string[] = []
  for (const line of out.split('\n')) {
    if (line.startsWith('HERMES=')) hermes = line.slice(7).trim() || null
    else if (line.startsWith('VERSION=')) {
      // "Hermes Agent v0.23.1 (2026.9.24) · stable · local 3b42…" → "Hermes Agent v0.23.1"
      const v = line.slice(8).trim()
      version = /Hermes Agent v[\w.-]+/.exec(v)?.[0] ?? (v || null)
    }
    else if (line.startsWith('PROFILE=')) profiles.push(line.slice(8).trim())
  }
  return { hermes, version, profiles: [...new Set(profiles)] }
}

const INSTALL_HINT = 'Install Hermes Agent first: hermes-agent.nousresearch.com/docs'

/** This Mac. Runs the probe in a login shell so a Finder-launched app sees the user's PATH. */
export async function scanLocal(): Promise<SetupScan> {
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  try {
    const { stdout } = await run(shell, ['-lc', PROBE], { timeout: 20_000 })
    const r = parseProbe(stdout)
    if (!r.hermes) return { ok: false, ...r, error: 'Hermes isn’t installed on this Mac', hint: INSTALL_HINT }
    if (!r.profiles.length) return { ok: false, ...r, error: 'Hermes is installed but has no profile yet', hint: 'Run `hermes setup` once in Terminal, then scan again.' }
    return { ok: true, ...r }
  } catch (err) {
    return { ok: false, hermes: null, version: null, profiles: [], error: friendlyError(err) }
  }
}

/** A server over SSH (key auth, non-interactive). */
export async function scanRemote(host: string): Promise<SetupScan> {
  try {
    // The probe goes inline (sh -c '…'), so ssh never waits on stdin.
    const { stdout } = await run('ssh', [...sshBase(host), `sh -c ${shQuote(PROBE)}`], { timeout: 30_000 })
    const r = parseProbe(stdout)
    if (!r.hermes) return { ok: false, ...r, error: `Connected to ${host}, but Hermes isn’t installed there`, hint: INSTALL_HINT }
    if (!r.profiles.length) return { ok: false, ...r, error: `Hermes on ${host} has no profile yet`, hint: `Run \`hermes setup\` on ${host} once, then try again.` }
    return { ok: true, ...r }
  } catch (err) {
    const error = friendlyError(err)
    return { ok: false, hermes: null, version: null, profiles: [], error, hint: hintFor(error, host) }
  }
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

function hintFor(error: string, host: string): string {
  if (/key was refused/i.test(error)) return `Set up key login once in Terminal: ssh-copy-id ${host}`
  if (/find the server/i.test(error)) return `Check the name, or add a "Host ${host}" entry to ~/.ssh/config.`
  if (/not answering|refused|No network/i.test(error)) return 'Is the server on and reachable from here? (VPN or Tailscale connected?)'
  return `Check that \`ssh ${host}\` works in Terminal without asking for a password.`
}

/** Host aliases from ~/.ssh/config (no wildcards), for the host picker. */
export function sshHosts(): string[] {
  const file = path.join(os.homedir(), '.ssh', 'config')
  if (!existsSync(file)) return []
  const hosts = new Set<string>()
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*Host\s+(.+)$/i.exec(raw)
    if (!m) continue
    for (const h of m[1]!.split(/\s+/)) if (h && !/[*?!]/.test(h)) hosts.add(h)
  }
  return [...hosts].sort()
}
