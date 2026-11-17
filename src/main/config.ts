import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { AppConfig } from '../shared/types'

/** `HERMESCHAN_HOME` points HermesChan at another config folder (testing, or a second setup). */
export const CONFIG_DIR = process.env.HERMESCHAN_HOME || path.join(os.homedir(), '.hermes-chan')
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

const DEFAULTS: AppConfig = {
  bots: [],
  hiddenSources: ['cron', 'tool', 'kanban', 'subagent']
}

/** Read ~/.hermes-chan/config.json. A fresh install has none: the app then opens its setup flow,
 *  which writes the file (see saveConfig). */
export function loadConfig(): AppConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS, bots: [] }
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as AppConfig
  return { ...DEFAULTS, ...parsed }
}

export function saveConfig(config: AppConfig) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)
}
