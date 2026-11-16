/// <reference types="vite/client" />
import type { HermesBridge } from '../../shared/types'

declare global {
  interface Window {
    hermes: HermesBridge
  }
}
