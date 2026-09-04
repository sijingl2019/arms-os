import type { ArmsOsBridge } from '@shared/types'

declare global {
  interface Window {
    arms: ArmsOsBridge
  }
}

export {}
