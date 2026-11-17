/** Dev helper: drive a running HermesChan over Chrome DevTools Protocol.
 *  Start the app with `pnpm build && pnpm exec electron . --remote-debugging-port=9333`, then:
 *    pnpm tsx scripts/cdp.ts shot out.png            screenshot
 *    pnpm tsx scripts/cdp.ts eval "document.title"   evaluate JS in the renderer
 *    pnpm tsx scripts/cdp.ts shot-size 1180 1000 out.png   screenshot at a given window size */
import { writeFileSync } from 'node:fs'

const port = process.env.CDP_PORT ?? '9333'
const [cmd, arg] = process.argv.slice(2)

const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
const page = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools'))
if (!page) throw new Error('no page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const call = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve, reject) => {
    const my = ++id
    const on = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id !== my) return
      ws.removeEventListener('message', on)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id: my, method, params }))
  })

if (cmd === 'shot-size') {
  // pnpm tsx scripts/cdp.ts shot-size 1180 1000 out.png — render at a given CSS size (2x), then capture
  const [, w, h, out = 'shot.png'] = process.argv.slice(2)
  await call('Emulation.setDeviceMetricsOverride', { width: Number(w), height: Number(h), deviceScaleFactor: 2, mobile: false })
  await new Promise(r => setTimeout(r, 400))
  const { data } = await call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(data, 'base64'))
  await call('Emulation.clearDeviceMetricsOverride')
  console.log('saved', out)
} else if (cmd === 'shot') {
  const { data } = await call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(arg ?? 'shot.png', Buffer.from(data, 'base64'))
  console.log('saved', arg ?? 'shot.png')
} else if (cmd === 'eval') {
  const res = await call('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true })
  console.log(JSON.stringify(res.result?.value ?? res.exceptionDetails ?? res.result, null, 1))
}
ws.close()
