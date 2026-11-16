/** Types shared by main, preload and renderer. */
import type { Transport } from '../main/transport'

export type { Transport }

export interface BotConfig {
  /** Stable id used for local state (unread markers, last-used). */
  id: string
  /** Fallback display name; the profile's own display name wins when it has one. */
  name?: string
  /** Fallback colour (any CSS colour); the profile's Bot Mode colour wins. */
  color?: string
  transport: Transport
}

export interface AppConfig {
  bots: BotConfig[]
  /** Session sources hidden from the Chats list unless "show routine runs" is on. */
  hiddenSources?: string[]
}

export type ConnState = 'connecting' | 'ready' | 'reconnecting' | 'error'

export interface BotStatus {
  botId: string
  state: ConnState
  detail?: string
}

export interface GatewayEventEnvelope {
  botId: string
  event: { type: string; session_id?: string; payload?: any; replayed?: boolean }
}

export interface ServerRequestEnvelope {
  botId: string
  id: string
  method: string
  params: Record<string, any>
}

export interface HermesBridge {
  config(): Promise<AppConfig>
  request<T = any>(botId: string, method: string, params?: Record<string, unknown>): Promise<T>
  respond(botId: string, requestId: string, result: Record<string, unknown>): Promise<void>
  /** Store an image on the bot's gateway host; returns the gateway-visible path for `attachments`. */
  uploadImage(botId: string, dataUrl: string, filename: string): Promise<{ path: string; mime: string }>
  /** Hermes Desktop's favourite models (`provider::model`) and per-model presets. */
  desktopModelPrefs(): Promise<{
    favorites: string[]
    presets: Record<string, { fast?: boolean; effort?: string; serviceTier?: string }>
  }>
  /** Read a gateway-visible file back as a data URL. */
  readDataUrl(botId: string, filePath: string): Promise<string>
  onEvent(cb: (e: GatewayEventEnvelope) => void): () => void
  onRequest(cb: (r: ServerRequestEnvelope) => void): () => void
  onStatus(cb: (s: BotStatus) => void): () => void
  statuses(): Promise<BotStatus[]>
  openExternal(url: string): void
  configPath(): Promise<string>
}
