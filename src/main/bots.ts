/** One live gateway connection per configured bot, multiplexed to the renderer over IPC. */
import { app } from 'electron'

import { GatewayClient } from '../../vendor/hermes-shared/node/gateway-client'
import type { ServerRequest } from '../../vendor/hermes-shared/json-rpc-channel'
import type { BotConfig, BotStatus, GatewayEventEnvelope, ServerRequestEnvelope } from '../shared/types'
import { connectGateway, type Endpoint, mintHttpTicket, resetHost } from './transport'

/** One line a person can act on, from an ssh / attach / socket failure. */
export function friendlyError(err: unknown): string {
  const e = err as { message?: string; stderr?: string; code?: string | number }
  const text = `${e?.stderr ?? ''} ${e?.message ?? ''}`
  if (/Could not resolve hostname|Name or service not known/i.test(text)) return "Can't find this server"
  if (/timed out|ETIMEDOUT|Operation timed out/i.test(text)) return 'The server is not answering'
  if (/Connection refused|ECONNREFUSED/i.test(text)) return 'Connection refused'
  if (/Permission denied|publickey/i.test(text)) return 'SSH key was refused'
  if (/Network is unreachable|ENETUNREACH|No route to host/i.test(text)) return 'No network'
  if (/gateway not ready/i.test(text)) return (e.message ?? '').replace(/^Error:\s*/, '')
  const first = (e?.stderr || e?.message || String(err)).split('\n').find(l => l.trim()) ?? 'Connection failed'
  return first.slice(0, 160)
}

interface Sinks {
  event: (e: GatewayEventEnvelope) => void
  request: (r: ServerRequestEnvelope) => void
  status: (s: BotStatus) => void
}

export class BotConnection {
  gw!: GatewayClient
  status: BotStatus
  endpoint: Endpoint | null = null
  private pending = new Map<string, ServerRequest>()
  private lastError: string | undefined
  private reconnecting: Promise<void> | null = null

  constructor(readonly bot: BotConfig, private sinks: Sinks) {
    this.status = { botId: bot.id, state: 'connecting' }
    this.build()
  }

  /** A fresh gateway client. Handlers ignore events from a client that has since been replaced. */
  private build() {
    const bot = this.bot
    const gw = new GatewayClient({
      connect: async (start, recover) => {
        try {
          const conn = await connectGateway(bot.transport, start, recover)
          this.endpoint = conn.endpoint
          this.lastError = undefined
          return conn
        } catch (err) {
          // Shown in the UI while the client keeps retrying on its own backoff.
          this.lastError = friendlyError(err)
          if (gw === this.gw && this.status.state !== 'connecting') this.setStatus('reconnecting', this.lastError)
          throw err
        }
      },
      source: 'tui',
      client: { name: 'hermes-chan', version: app.getVersion() },
      onLifecycle: line => console.log(`[${bot.id}] ${line}`)
    })
    this.gw = gw

    gw.on('event', (event: GatewayEventEnvelope['event']) => {
      if (gw !== this.gw) return
      if (event.type === 'gateway.ready') {
        // Advertise that we answer approval / clarify prompts; without it the gateway treats this
        // socket as a client that can't, and routes them elsewhere.
        void gw.request('client.capabilities', { server_requests: true }).catch(() => undefined)
        this.setStatus('ready')
      } else if (event.type === 'gateway.reconnecting') {
        const attempt = (event.payload as { attempt?: number } | undefined)?.attempt
        this.setStatus('reconnecting', this.lastError ?? (attempt ? `Retrying (attempt ${attempt})` : undefined))
      } else if (event.type === 'gateway.start_timeout') {
        this.setStatus('error', this.lastError ?? 'The gateway did not start in time')
      } else if (event.type === 'gateway.exit' || event.type === 'gateway.disconnected') {
        this.setStatus('reconnecting', this.lastError)
      }
      this.sinks.event({ botId: bot.id, event })
    })

    gw.on('request', (req: ServerRequest) => {
      if (gw !== this.gw) return
      this.pending.set(req.id, req)
      this.sinks.request({ botId: bot.id, id: req.id, method: req.method, params: req.params })
    })

    gw.on('exit', () => {
      if (gw === this.gw) this.setStatus('reconnecting', this.lastError)
    })
  }

  start() {
    this.gw.start()
    this.gw.drain()
  }

  /** Throw away the client (and, for SSH bots, the SSH master and tunnels) and dial again from
   *  scratch. Safe to call repeatedly; concurrent calls share one attempt. */
  reconnect(): Promise<void> {
    if (this.reconnecting) return this.reconnecting
    this.reconnecting = (async () => {
      this.setStatus('connecting', 'Reconnecting…')
      const old = this.gw
      this.pending.clear()
      try {
        old.kill('reconnect')
      } catch {
        /* already gone */
      }
      if (this.bot.transport.kind === 'ssh') await resetHost(this.bot.transport.host)
      this.build()
      this.start()
    })().finally(() => {
      this.reconnecting = null
    })
    return this.reconnecting
  }

  async request(method: string, params: Record<string, unknown> = {}) {
    try {
      const res = await this.gw.request(method, params)
      if (this.status.state !== 'ready') this.setStatus('ready')
      return res
    } catch (err) {
      const e = err as Error & { code?: number; data?: unknown }
      // Errors cross IPC as plain objects; keep the bits the UI reads.
      throw new Error(JSON.stringify({ message: e.message, code: e.code, data: e.data }))
    }
  }

  /** Store an image on the gateway host (`/api/chat/image-upload`); returns its gateway-visible path. */
  async uploadImage(dataUrl: string, filename: string): Promise<{ path: string; mime: string }> {
    const ep = this.endpoint
    if (!ep) throw new Error(`${this.bot.name ?? this.bot.id} isn't connected yet`)
    const ticket = await mintHttpTicket(this.bot.transport, ep)
    const profile = this.bot.transport.profile
    const url = `${ep.apiOrigin}/api/chat/image-upload${profile && profile !== 'default' ? `?profile=${encodeURIComponent(profile)}` : ''}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hermes-Gateway-Ticket': ticket },
      body: JSON.stringify({ data_url: dataUrl, filename })
    })
    const body = (await res.json().catch(() => ({}))) as { path?: string; mime_type?: string; detail?: string }
    if (!res.ok || !body.path) throw new Error(body.detail || `Upload failed (${res.status})`)
    return { path: body.path, mime: body.mime_type ?? 'image/png' }
  }

  /** Read a gateway-visible file back as a data URL (image thumbnails in history). */
  async readDataUrl(filePath: string): Promise<string> {
    const ep = this.endpoint
    if (!ep) throw new Error('not connected')
    const ticket = await mintHttpTicket(this.bot.transport, ep)
    const q = new URLSearchParams({ path: filePath })
    const profile = this.bot.transport.profile
    if (profile && profile !== 'default') q.set('profile', profile)
    const res = await fetch(`${ep.apiOrigin}/api/fs/read-data-url?${q}`, { headers: { 'X-Hermes-Gateway-Ticket': ticket } })
    const body = (await res.json().catch(() => ({}))) as { dataUrl?: string; detail?: string }
    if (!res.ok || !body.dataUrl) throw new Error(body.detail || `Read failed (${res.status})`)
    return body.dataUrl
  }

  respond(id: string, result: Record<string, unknown>) {
    const req = this.pending.get(id)
    if (!req) return
    req.respond(result)
    this.pending.delete(id)
  }

  stop() {
    this.gw.kill('app quit')
  }

  private setStatus(state: BotStatus['state'], detail?: string) {
    this.status = { botId: this.bot.id, state, detail }
    this.sinks.status(this.status)
  }
}
