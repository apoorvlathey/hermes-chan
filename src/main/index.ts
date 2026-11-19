import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app, BrowserWindow, ipcMain, nativeTheme, Notification, powerMonitor, shell } from 'electron'

import type { AppConfig, BotConfig, BotStatus, GatewayEventEnvelope, ReplyNotice, ServerRequestEnvelope } from '../shared/types'
import { BotConnection, friendlyError } from './bots'
import { CONFIG_PATH, loadConfig, saveConfig } from './config'
import { registerKanbanIpc } from './kanban-ipc'
import { scanLocal, scanRemote, sshHosts } from './setup'
import { closeTransports } from './transport'
import { listWorkstreams } from './workstreams'

/** `HERMESCHAN_DEMO=1` (pnpm demo): fake backend in the renderer, no gateway connections, and a
 *  separate userData folder so demo unread/pin state never mixes with the real app's. */
const DEMO = process.env.HERMESCHAN_DEMO === '1' || process.env.HERMESCHAN_DEMO === 'onboarding'
/** `HERMESCHAN_DEMO=onboarding` starts the demo on its first-run setup screen. */
const DEMO_Q = process.env.HERMESCHAN_DEMO === 'onboarding' ? 'onboarding' : '1'
if (DEMO) app.setPath('userData', path.join(os.homedir(), '.hermes-chan', 'demo-userdata'))
// A custom config folder also gets its own unread/pin state.
else if (process.env.HERMESCHAN_HOME) app.setPath('userData', path.join(process.env.HERMESCHAN_HOME, 'userdata'))

let config: AppConfig = DEMO ? { bots: [] } : loadConfig()
const bots = new Map<string, BotConnection>()
let win: BrowserWindow | null = null

const send = (channel: string, payload: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'HermesChan',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17151c' : '#faf8f4',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) {
      e.preventDefault()
      void shell.openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${DEMO ? `?demo=${DEMO_Q}` : ''}`)
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'), DEMO ? { query: { demo: DEMO_Q } } : undefined)
}

function startBots() {
  for (const bot of config.bots) {
    const conn = new BotConnection(bot, {
      event: (e: GatewayEventEnvelope) => send('hermes:event', e),
      request: (r: ServerRequestEnvelope) => send('hermes:request', r),
      status: (s: BotStatus) => send('hermes:status', s)
    })
    bots.set(bot.id, conn)
    conn.start()
  }
}

registerKanbanIpc(
  ipcMain,
  botId => config.bots.find(bot => bot.id === botId)?.transport,
  event => !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
)

ipcMain.handle('hermes:config', () => config)
ipcMain.handle('setup:scan-local', () => scanLocal())
ipcMain.handle('setup:scan-remote', (_e, host: string) => scanRemote(String(host).trim()))
ipcMain.handle('setup:ssh-hosts', () => sshHosts())
ipcMain.handle('setup:save', async (_e, next: BotConfig[]) => {
  if (DEMO) return
  // Stop every current connection (and SSH masters of hosts we drop), save, start fresh, repaint.
  const oldHosts = new Set(config.bots.flatMap(b => (b.transport.kind === 'ssh' ? [b.transport.host] : [])))
  for (const b of bots.values()) b.stop()
  bots.clear()
  config = { ...config, bots: next }
  saveConfig(config)
  const keep = new Set(next.flatMap(b => (b.transport.kind === 'ssh' ? [b.transport.host] : [])))
  await closeTransports([...oldHosts].filter(h => !keep.has(h)))
  startBots()
  win?.webContents.reload()
})
ipcMain.handle('hermes:reorder-bots', (_e, ids: string[]) => {
  if (DEMO || !Array.isArray(ids)) return
  const rank = (id: string) => {
    const i = ids.indexOf(id)
    return i < 0 ? ids.length : i
  }
  config = { ...config, bots: [...config.bots].sort((a, b) => rank(a.id) - rank(b.id)) }
  saveConfig(config)
})
ipcMain.handle('hermes:config-path', () => CONFIG_PATH)
ipcMain.handle('hermes:statuses', () => [...bots.values()].map(b => b.status))
ipcMain.handle('hermes:request', (_e, botId: string, method: string, params: Record<string, unknown>) => {
  const conn = bots.get(botId)
  if (!conn) throw new Error(`unknown bot ${botId}`)
  return conn.request(method, params)
})
ipcMain.handle('hermes:upload-image', async (_e, botId: string, dataUrl: string, filename: string) => {
  const conn = bots.get(botId)
  if (!conn) throw new Error(`unknown bot ${botId}`)
  try {
    return await conn.uploadImage(dataUrl, filename)
  } catch (err) {
    throw new Error(JSON.stringify({ message: (err as Error).message }))
  }
})
ipcMain.handle('hermes:read-data-url', async (_e, botId: string, filePath: string) => {
  const conn = bots.get(botId)
  if (!conn) throw new Error(`unknown bot ${botId}`)
  try {
    return await conn.readDataUrl(filePath)
  } catch (err) {
    throw new Error(JSON.stringify({ message: (err as Error).message }))
  }
})
ipcMain.handle('hermes:workstreams', async (_e, botId: string) => {
  const conn = bots.get(botId)
  if (!conn) throw new Error(`unknown bot ${botId}`)
  try {
    return await listWorkstreams(conn.bot.transport)
  } catch (err) {
    throw new Error(JSON.stringify({ message: friendlyError(err) }))
  }
})
/** Favourite models and per-model presets from Hermes Desktop's own preferences, so the picker
 *  starts with the same stars and fast/effort defaults. Read-only; missing file → empty. */
ipcMain.handle('hermes:desktop-model-prefs', () => {
  try {
    const raw = JSON.parse(readFileSync(path.join(os.homedir(), '.hermes', 'ui-preferences.json'), 'utf8'))
    const v = raw?.values ?? {}
    const parse = (s: unknown, fallback: unknown) => {
      try {
        return typeof s === 'string' ? JSON.parse(s) : fallback
      } catch {
        return fallback
      }
    }
    return { favorites: parse(v['hermes.desktop.favorite-models'], []), presets: parse(v['hermes.desktop.model-presets'], {}) }
  } catch {
    return { favorites: [], presets: {} }
  }
})
ipcMain.handle('hermes:respond', (_e, botId: string, id: string, result: Record<string, unknown>) => {
  bots.get(botId)?.respond(id, result)
})
/** Reconnect one bot, or every bot that isn't online. */
const reconnect = (botId?: string) =>
  Promise.all(
    [...bots.values()]
      .filter(b => (botId ? b.bot.id === botId : b.status.state !== 'ready'))
      .map(b => b.reconnect())
  ).then(() => undefined)

ipcMain.handle('hermes:reconnect', (_e, botId?: string) => reconnect(botId))
/** Notifications must stay referenced until they're dismissed, or a click after GC does nothing. */
const notices = new Set<Notification>()

ipcMain.on('hermes:notify', (_e, n: ReplyNotice) => {
  if (!win || win.isFocused()) return
  app.dock?.bounce('informational')
  if (!Notification.isSupported()) return
  const note = new Notification({ title: n.title, subtitle: n.subtitle, body: n.body })
  notices.add(note)
  const drop = () => notices.delete(note)
  note.on('click', () => {
    drop()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    send('hermes:open-chat', { botId: n.botId, sessionId: n.sessionId })
  })
  note.on('close', drop)
  note.show()
})
ipcMain.on('hermes:open-external', (_e, url: string) => {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url)
})

app.setName('HermesChan')
nativeTheme.themeSource = 'system'

/** build/icon.png, relative to out/main/ (dev and `pnpm start`). Packaged builds use build/icon.icns. */
const ICON_PATH = path.join(import.meta.dirname, '../../build/icon.png')

app.whenReady().then(() => {
  // After sleep or a lock, SSH links are usually dead; rebuild the ones that didn't come back.
  const nudge = () => setTimeout(() => void reconnect(), 3000)
  powerMonitor.on('resume', nudge)
  powerMonitor.on('unlock-screen', nudge)
  // Without a packaged bundle the Dock shows Electron's icon; set ours.
  if (process.platform === 'darwin' && existsSync(ICON_PATH)) app.dock?.setIcon(ICON_PATH)
  startBots()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', e => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  for (const b of bots.values()) b.stop()
  const hosts = config.bots.flatMap(b => (b.transport.kind === 'ssh' ? [b.transport.host] : []))
  const done = () => app.exit(0)
  setTimeout(done, 3000)
  void closeTransports([...new Set(hosts)]).finally(done)
})

for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => app.quit())
