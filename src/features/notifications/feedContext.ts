import { createContext, useContext } from 'react'
import type { CookRequest } from '@/features/kitchen/api'
import type { PushResult } from './push'

/** Push state of this device: 'on' = alerts arrive even when TSONE is closed. */
export type PushStatus = PushResult | 'off' | 'checking'

export interface KitchenRequestFeed {
  /** False when the user has no Kitchen access (no polling, no bell). */
  enabled: boolean
  open: CookRequest[]
  recentDone: CookRequest[]
  loading: boolean
  error: string
  /** Epoch ms of the last successful load (0 = never). */
  loadedAt: number
  reload: () => Promise<void>
  isUnread: (r: CookRequest) => boolean
  unreadCount: number
  /** Mark these requests (or all open ones) as read on this device. */
  markRead: (requestIds?: string[]) => void
  /** Newest request that arrived while the app was on screen (for the toast). */
  arrival: { request: CookRequest; count: number; seq: number } | null
  dismissArrival: () => void
  push: PushStatus
  /** Turn push for this device on (after permission) or off. */
  setPush: (on: boolean) => Promise<void>
  /** Push a test notification to this device after a short delay. */
  testPush: (delaySeconds: number) => Promise<{ ok: boolean; error?: string }>
}

const disabled: KitchenRequestFeed = {
  enabled: false,
  open: [],
  recentDone: [],
  loading: false,
  error: '',
  loadedAt: 0,
  reload: async () => {},
  isUnread: () => false,
  unreadCount: 0,
  markRead: () => {},
  arrival: null,
  dismissArrival: () => {},
  push: 'off',
  setPush: async () => {},
  testPush: async () => ({ ok: false }),
}

export const KitchenFeedContext = createContext<KitchenRequestFeed>(disabled)

export function useKitchenRequestFeed(): KitchenRequestFeed {
  return useContext(KitchenFeedContext)
}

/** Identity of one alert for a request: a reminder from the server makes it new again. */
export function alertKey(r: CookRequest): string {
  return `${r.lastNotifiedAt || r.createdAt || ''}`
}

export function isReminder(r: CookRequest): boolean {
  return !!r.lastNotifiedAt && (Number(r.notifyCount) || 0) > 0
}
