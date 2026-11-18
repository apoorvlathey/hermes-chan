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

/** Result of looking for Hermes on this Mac or on an SSH host (setup flow). */
export interface SetupScan {
  ok: boolean
  /** Path to the `hermes` binary, when found. */
  hermes: string | null
  version: string | null
  /** Profile names on disk ("default" plus ~/.hermes/profiles/*). */
  profiles: string[]
  error?: string
  /** What to do about the error, in one sentence. */
  hint?: string
  /** A command that fixes it, shown copyable. */
  command?: string
  /** Offer the Hermes Agent install guide. */
  install?: boolean
}

/** One of a bot's workstreams (Conduit plugin): a task it runs in its own, usually hidden, session. */
export interface Workstream {
  ref: string
  /** starting | running | needs_you | waiting | ready | done | failed | stopped | interrupted */
  status: string
  sessionId: string
  title: string
  steps: { step: string; state: string }[]
  lastResult: string
  error: string
  createdAt: number
  updatedAt: number
  closedAt: number
}

export interface ReplyNotice {
  botId: string
  sessionId: string
  title: string
  subtitle?: string
  body: string
}

export interface HermesBridge {
  config(): Promise<AppConfig>
  request<T = any>(botId: string, method: string, params?: Record<string, unknown>): Promise<T>
  respond(botId: string, requestId: string, result: Record<string, unknown>): Promise<void>
  /** Store an image on the bot's gateway host; returns the gateway-visible path for `attachments`. */
  uploadImage(botId: string, dataUrl: string, filename: string): Promise<{ path: string; mime: string }>
  /** Setup flow: look for Hermes here / on a host, list ~/.ssh/config hosts, save the bot list. */
  setupScanLocal(): Promise<SetupScan>
  setupScanRemote(host: string): Promise<SetupScan>
  setupSshHosts(): Promise<string[]>
  /** Writes ~/.hermes-chan/config.json, reconnects every bot and reloads the window. */
  setupSave(bots: BotConfig[]): Promise<void>
  /** Saves a new order for the configured bots (ids, first to last); connections stay up. */
  reorderBots(ids: string[]): Promise<void>
  /** Rebuild a bot's connection from scratch (or every offline bot when omitted). */
  reconnect(botId?: string): Promise<void>
  /** Hermes Desktop's favourite models (`provider::model`) and per-model presets. */
  desktopModelPrefs(): Promise<{
    favorites: string[]
    presets: Record<string, { fast?: boolean; effort?: string; serviceTier?: string }>
  }>
  /** Read a gateway-visible file back as a data URL. */
  readDataUrl(botId: string, filePath: string): Promise<string>
  /** The bot's workstreams from the Conduit plugin's registry ([] when it has none). */
  workstreams(botId: string): Promise<Workstream[]>
  onEvent(cb: (e: GatewayEventEnvelope) => void): () => void
  onRequest(cb: (r: ServerRequestEnvelope) => void): () => void
  onStatus(cb: (s: BotStatus) => void): () => void
  /** A finished reply while the window is in the background: bounce the dock icon and post a
   *  notification (skipped by the main process if the window has focus). */
  notify(n: ReplyNotice): void
  /** The user clicked a reply notification: open that chat. */
  onOpenChat(cb: (target: { botId: string; sessionId: string }) => void): () => void
  statuses(): Promise<BotStatus[]>
  openExternal(url: string): void
  configPath(): Promise<string>
}
