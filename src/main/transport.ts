/** Getting a ticketed WebSocket URL for one Hermes profile.
 *
 *  - `local`: run `hermes -p <profile> gateway attach --json` on this Mac.
 *  - `ssh`:   run the same command on the remote host over a shared SSH ControlMaster, then forward
 *             the gateway's loopback port to a local port on that same master and rewrite the URL.
 *
 *  The ticket in the result is single-use and expires in ~30s, so this runs on every (re)connect. */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { GatewayConnection } from '../../vendor/hermes-shared/node/gateway-client'

const run = promisify(execFile)

export type Transport =
  | { kind: 'local'; profile: string; hermes?: string }
  | { kind: 'ssh'; host: string; profile: string; hermes?: string }

interface AttachResult {
  state: string
  url: string
  protocols: string[]
  endpoint: { profile_id: string; instance_id: string; api_origin: string; control_home?: string | null }
  detail?: string | null
}

/** What we need later to mint REST tickets and reach the dashboard API for this bot. */
export interface Endpoint {
  profileId: string
  instanceId: string
  controlHome: string
  apiOrigin: string
}

const CONTROL_DIR = path.join(os.homedir(), '.hermes-chan', 'ssh')

function controlPath(host: string) {
  mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 })
  // Keep it short: unix socket paths are capped at ~104 bytes on macOS.
  return path.join(CONTROL_DIR, `${host.replace(/[^a-zA-Z0-9_.-]/g, '_')}.sock`)
}

export function sshBase(host: string) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    // Notice a dead link (sleep, Wi-Fi change) within ~20s instead of hanging on it.
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath(host)}`,
    '-o', 'ControlPersist=yes',
    host
  ]
}

function attachArgs(t: Transport, start: boolean, recover: boolean) {
  const args = ['-p', t.profile, 'gateway', 'attach', '--json']
  if (start) args.push('--start')
  else if (recover) args.push('--recover')
  return args
}

function parseAttach(stdout: string): AttachResult {
  const parsed = JSON.parse(stdout) as AttachResult
  if (parsed.state !== 'ready' || !parsed.url) {
    throw new Error(`gateway not ready (${parsed.state}${parsed.detail ? `: ${parsed.detail}` : ''})`)
  }
  return parsed
}

async function execAttach(t: Transport, start: boolean, recover: boolean): Promise<AttachResult> {
  try {
    if (t.kind === 'local') {
      const bin = t.hermes ?? path.join(os.homedir(), '.local', 'bin', 'hermes')
      const { stdout } = await run(bin, attachArgs(t, start, recover), { timeout: 90_000 })
      return parseAttach(stdout)
    }
    const bin = t.hermes ?? '$HOME/.local/bin/hermes'
    const remote = [bin, ...attachArgs(t, start, recover)].join(' ')
    const { stdout } = await run('ssh', [...sshBase(t.host), remote], { timeout: 90_000 })
    return parseAttach(stdout)
  } catch (err) {
    // execFile rejects on non-zero exit; attach still prints its verdict JSON on stdout.
    const stdout = (err as { stdout?: string }).stdout
    if (stdout) {
      try {
        parseAttach(stdout)
      } catch (inner) {
        throw inner
      }
    }
    throw err
  }
}

/** remote port → local port, per host. Reused only while the tunnel still answers: when the SSH
 *  master dies (sleep, network change) its forwards die with it and must be re-created. */
const forwards = new Map<string, number>()

/** Does anything accept connections on this local port (i.e. is the tunnel listener alive)? */
function portAlive(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(1500, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

async function ensureForward(host: string, remotePort: number): Promise<number> {
  const key = `${host}:${remotePort}`
  const existing = forwards.get(key)
  if (existing && (await portAlive(existing))) return existing
  forwards.delete(key)
  const local = await freePort()
  await run('ssh', ['-O', 'forward', '-L', `127.0.0.1:${local}:127.0.0.1:${remotePort}`, ...sshBase(host)], {
    timeout: 20_000
  })
  forwards.set(key, local)
  return local
}

export async function connectGateway(
  t: Transport,
  start: boolean,
  recover: boolean
): Promise<GatewayConnection & { apiOrigin: string; endpoint: Endpoint }> {
  const res = await execAttach(t, start, recover)
  let url = res.url
  let apiOrigin = res.endpoint.api_origin
  if (t.kind === 'ssh') {
    const remote = new URL(res.url)
    const local = await ensureForward(t.host, Number(remote.port))
    remote.host = `127.0.0.1:${local}`
    url = remote.toString()
    apiOrigin = `http://127.0.0.1:${local}`
  }
  return {
    url,
    protocols: res.protocols,
    profile_id: res.endpoint.profile_id,
    instance_id: res.endpoint.instance_id,
    apiOrigin,
    endpoint: {
      profileId: res.endpoint.profile_id,
      instanceId: res.endpoint.instance_id,
      // A served secondary profile has no socket of its own; its multiplexer's home mints for it.
      controlHome: res.endpoint.control_home || res.endpoint.profile_id,
      apiOrigin
    }
  }
}

// ─── REST tickets ───────────────────────────────────────────────────────────────────────────────
// The dashboard REST API (uploads) wants a single-use `X-Hermes-Gateway-Ticket` with purpose
// `native-http`, minted on the gateway's owner-only Unix control socket — the same verb Hermes
// Desktop uses (apps/desktop/electron/local-gateway.ts::mintLocalGatewayTicket).

const MINT_PY = `
import json, os, socket, sys
home, control, inst = sys.argv[1], sys.argv[2], sys.argv[3]
p = os.path.join(control, 'gateway.sock')
if not os.path.exists(p):
    p = open(os.path.join(control, 'gateway.sock.path')).read().strip()
s = socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect(p)
s.sendall((json.dumps({'protocol': 1, 'id': 1, 'verb': 'session-ticket',
  'params': {'profile_id': home, 'instance_id': inst, 'purpose': 'native-http'}}) + '\\n').encode())
buf = b''
while b'\\n' not in buf:
    c = s.recv(65536)
    if not c: break
    buf += c
r = json.loads(buf.split(b'\\n')[0])
if not r.get('ok') or r.get('result', {}).get('profile_id') != home: sys.exit('ticket refused')
print(r['result']['ticket'])
`

function mintLocal(ep: Endpoint): Promise<string> {
  let sock = path.join(ep.controlHome, 'gateway.sock')
  if (!existsSync(sock)) sock = readFileSync(path.join(ep.controlHome, 'gateway.sock.path'), 'utf8').trim()
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock)
    let buf = ''
    const deadline = setTimeout(() => s.destroy(new Error('ticket deadline')), 5000)
    s.on('error', reject)
    s.on('connect', () =>
      s.write(`${JSON.stringify({ protocol: 1, id: 1, verb: 'session-ticket', params: { profile_id: ep.profileId, instance_id: ep.instanceId, purpose: 'native-http' } })}\n`)
    )
    s.on('data', chunk => {
      buf += chunk.toString()
      if (!buf.includes('\n')) return
      clearTimeout(deadline)
      s.destroy()
      try {
        const r = JSON.parse(buf.split('\n')[0]!)
        if (!r.ok || r.result?.profile_id !== ep.profileId) throw new Error('ticket refused')
        resolve(r.result.ticket as string)
      } catch (e) {
        reject(e)
      }
    })
  })
}

async function mintRemote(host: string, ep: Endpoint): Promise<string> {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const child = execFile('ssh', [...sshBase(host), `python3 - ${q(ep.profileId)} ${q(ep.controlHome)} ${q(ep.instanceId)}`], {
    timeout: 20_000
  })
  child.stdin?.end(MINT_PY)
  const out = await new Promise<string>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', d => (stdout += d))
    child.stderr?.on('data', d => (stderr += d))
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `ticket mint exited ${code}`))))
  })
  return out
}

export const mintHttpTicket = (t: Transport, ep: Endpoint) => (t.kind === 'ssh' ? mintRemote(t.host, ep) : mintLocal(ep))

/** Hard reset for one host: forget its tunnels and close its SSH master, so the next connect
 *  builds everything fresh (the manual "Reconnect" and wake-from-sleep path). */
export async function resetHost(host: string) {
  for (const key of [...forwards.keys()]) if (key.startsWith(`${host}:`)) forwards.delete(key)
  await run('ssh', ['-O', 'exit', ...sshBase(host)], { timeout: 5000 }).catch(() => undefined)
}

/** Tear down SSH masters on quit (they're ControlPersist=yes otherwise). */
export async function closeTransports(hosts: string[]) {
  await Promise.allSettled(hosts.map(h => run('ssh', ['-O', 'exit', ...sshBase(h)], { timeout: 5000 })))
}
