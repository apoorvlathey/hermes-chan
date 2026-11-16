/** `window.hermes` with errors revived: the preload ships `{message, code, data}` as JSON in the
 *  error message (contextBridge drops other error fields), and this turns it back into an Error that
 *  carries `code` / `data` again. Use this instead of `window.hermes` for anything that can fail. */
import type { HermesBridge } from '../../shared/types'

export interface RpcError extends Error {
  code?: number
  data?: any
}

function revive(err: unknown): RpcError {
  const raw = err instanceof Error ? err.message : String(err)
  try {
    const parsed = JSON.parse(raw) as { message?: string; code?: number; data?: unknown }
    if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
      return Object.assign(new Error(parsed.message), { code: parsed.code, data: parsed.data })
    }
  } catch {
    /* not ours */
  }
  return err instanceof Error ? err : new Error(raw)
}

const w = window.hermes

export const hermes: HermesBridge = {
  ...w,
  request: (botId, method, params) => w.request(botId, method, params).catch(e => Promise.reject(revive(e))),
  uploadImage: (botId, dataUrl, filename) => w.uploadImage(botId, dataUrl, filename).catch(e => Promise.reject(revive(e))),
  readDataUrl: (botId, filePath) => w.readDataUrl(botId, filePath).catch(e => Promise.reject(revive(e)))
}
