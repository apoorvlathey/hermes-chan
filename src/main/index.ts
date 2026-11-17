import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app, BrowserWindow, ipcMain, nativeTheme, powerMonitor, shell } from 'electron'

import type { BotStatus, GatewayEventEnvelope, ServerRequestEnvelope } from '../shared/types'
import { BotConnection } from './bots'
import { CONFIG_PATH, loadConfig } from './config'
import { closeTransports } from './transport'

/** `HERMESCHAN_DEMO=1` (pnpm demo): fake backend in the renderer, no gateway connections, and a
 *  separate userData folder so demo unread/pin state never mixes with the real app's. */
const DEMO = process.env.HERMESCHAN_DEMO === '1'
if (DEMO) app.setPath('userData', path.join(os.homedir(), '.hermes-chan', 'demo-userdata'))

const config = DEMO ? { bots: [] } : loadConfig()
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

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${DEMO ? '?demo=1' : ''}`)
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'), DEMO ? { query: { demo: '1' } } : undefined)
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

ipcMain.handle('hermes:config', () => config)
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
