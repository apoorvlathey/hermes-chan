import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { AppConfig } from '../shared/types'

export const CONFIG_DIR = path.join(os.homedir(), '.hermes-chan')
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

// A generic starting point: the default Hermes profile on this Mac. Your real bots (remote hosts,
// other profiles) go in ~/.hermes-chan/config.json, which stays outside the repo.
const DEFAULT_CONFIG: AppConfig = {
  bots: [{ id: 'hermes', name: 'Hermes', transport: { kind: 'local', profile: 'default' } }],
  hiddenSources: ['cron', 'tool', 'kanban', 'subagent']
}

/** Read ~/.hermes-chan/config.json, writing the default on first run. */
export function loadConfig(): AppConfig {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
    return DEFAULT_CONFIG
  }
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as AppConfig
  return { ...DEFAULT_CONFIG, ...parsed }
}
