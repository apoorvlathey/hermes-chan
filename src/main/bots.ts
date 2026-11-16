/** One live gateway connection per configured bot, multiplexed to the renderer over IPC. */
import { GatewayClient } from '../../vendor/hermes-shared/node/gateway-client'
import type { ServerRequest } from '../../vendor/hermes-shared/json-rpc-channel'
import type { BotConfig, BotStatus, GatewayEventEnvelope, ServerRequestEnvelope } from '../shared/types'
import { connectGateway, type Endpoint, mintHttpTicket } from './transport'

interface Sinks {
  event: (e: GatewayEventEnvelope) => void
  request: (r: ServerRequestEnvelope) => void
  status: (s: BotStatus) => void
}

export class BotConnection {
  readonly gw: GatewayClient
  status: BotStatus
  endpoint: Endpoint | null = null
  private pending = new Map<string, ServerRequest>()

  constructor(readonly bot: BotConfig, private sinks: Sinks) {
    this.status = { botId: bot.id, state: 'connecting' }
    this.gw = new GatewayClient({
      connect: async (start, recover) => {
        const conn = await connectGateway(bot.transport, start, recover)
        this.endpoint = conn.endpoint
        return conn
      },
      source: 'tui',
      client: { name: 'hermes-chan', version: '0.1.0' },
      onLifecycle: line => console.log(`[${bot.id}] ${line}`)
    })

    this.gw.on('event', (event: GatewayEventEnvelope['event']) => {
      if (event.type === 'gateway.ready') {
        // Advertise that we answer approval / clarify prompts; without it the gateway treats this
        // socket as a client that can't, and routes them elsewhere.
        void this.gw.request('client.capabilities', { server_requests: true }).catch(() => undefined)
        this.setStatus('ready')
      } else if (event.type === 'gateway.start_timeout' || event.type === 'gateway.stderr') {
        // Surface but keep going; the client retries on its own.
      } else if (event.type === 'gateway.exit' || event.type === 'gateway.disconnected') {
        this.setStatus('reconnecting')
      }
      this.sinks.event({ botId: bot.id, event })
    })

    this.gw.on('request', (req: ServerRequest) => {
      this.pending.set(req.id, req)
      this.sinks.request({ botId: bot.id, id: req.id, method: req.method, params: req.params })
    })

    this.gw.on('exit', () => this.setStatus('reconnecting'))
  }

  start() {
    this.gw.start()
    this.gw.drain()
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
