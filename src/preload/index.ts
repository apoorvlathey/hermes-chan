import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { HermesBridge } from '../shared/types'

const listen = <T>(channel: string) => (cb: (v: T) => void) => {
  const fn = (_e: IpcRendererEvent, v: T) => cb(v)
  ipcRenderer.on(channel, fn)
  return () => ipcRenderer.removeListener(channel, fn)
}

const unwrap = async <T>(p: Promise<T>): Promise<T> => {
  try {
    return await p
  } catch (err) {
    // ipcRenderer.invoke wraps errors as "Error invoking remote method '…': Error: {json}".
    const msg = String((err as Error).message ?? err)
    let parsed: { message: string; code?: number } | null = null
    try {
      parsed = JSON.parse(msg.slice(msg.indexOf('{')))
    } catch {
      parsed = null
    }
    // contextBridge keeps only `message` on errors crossing into the page, so carry the whole
    // payload (code, data with fresh revision fences, …) as JSON there; renderer/bridge.ts revives it.
    throw new Error(JSON.stringify(parsed ?? { message: msg }))
  }
}

const bridge: HermesBridge = {
  config: () => ipcRenderer.invoke('hermes:config'),
  configPath: () => ipcRenderer.invoke('hermes:config-path'),
  statuses: () => ipcRenderer.invoke('hermes:statuses'),
  request: (botId, method, params = {}) => unwrap(ipcRenderer.invoke('hermes:request', botId, method, params)),
  uploadImage: (botId, dataUrl, filename) => unwrap(ipcRenderer.invoke('hermes:upload-image', botId, dataUrl, filename)),
  readDataUrl: (botId, filePath) => unwrap(ipcRenderer.invoke('hermes:read-data-url', botId, filePath)),
  desktopModelPrefs: () => ipcRenderer.invoke('hermes:desktop-model-prefs'),
  reconnect: botId => ipcRenderer.invoke('hermes:reconnect', botId),
  respond: (botId, id, result) => ipcRenderer.invoke('hermes:respond', botId, id, result),
  onEvent: listen('hermes:event'),
  onRequest: listen('hermes:request'),
  onStatus: listen('hermes:status'),
  openExternal: url => ipcRenderer.send('hermes:open-external', url)
}

contextBridge.exposeInMainWorld('hermes', bridge)
