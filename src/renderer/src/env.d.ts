/// <reference types="vite/client" />
import type { RunnerApi } from '../../preload/index.js'

declare global {
  interface Window {
    runner: RunnerApi
  }
}

export {}
