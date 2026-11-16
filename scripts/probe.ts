/** Dev probe: connect to one bot and dump the shapes of the RPCs the UI uses. Never prints tickets.
 *  pnpm probe [ssh-host|local] [profile] */
import { GatewayClient } from '../vendor/hermes-shared/node/gateway-client'
import { closeTransports, connectGateway, type Transport } from '../src/main/transport'

const [where = 'local', profile = 'default'] = process.argv.slice(2)
const t: Transport = where === 'local' ? { kind: 'local', profile } : { kind: 'ssh', host: where, profile }

const gw = new GatewayClient({ connect: (s, r) => connectGateway(t, s, r), source: 'tui', client: { name: 'hermes-chan', version: '0.1.0' } })
const seen = new Set<string>()
gw.on('event', (e: { type: string }) => {
  if (!seen.has(e.type)) {
    seen.add(e.type)
    console.log('[event]', e.type)
  }
})
gw.start()

const short = (v: unknown, n = 1800) => {
  const s = JSON.stringify(v, null, 1)
  return s.length > n ? `${s.slice(0, n)}…(${s.length})` : s
}

async function main() {
  await new Promise(r => setTimeout(r, 4000))
  for (const [m, p] of [
    ['profiles.list', {}],
    ['session.list', { picker: true, limit: 8 }]
  ] as const) {
    try {
      const res = await gw.request(m, p)
      console.log(`\n=== ${m}\n${short(res)}`)
    } catch (e) {
      console.log(`\n=== ${m} ERR`, (e as Error).message)
    }
  }
  process.exit(0)
}

main()
  .catch(e => console.error(e))
  .finally(() => closeTransports(t.kind === 'ssh' ? [t.host] : []))
