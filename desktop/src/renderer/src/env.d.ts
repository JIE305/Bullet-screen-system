/// <reference types="vite/client" />

import type { DaMuApi } from '../../shared/contracts'

declare global {
  interface Window {
    damu?: DaMuApi
  }
}

export {}

