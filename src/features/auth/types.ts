/** An authenticated operator session returned by the backend login. */
export interface Session {
  username: string
  deviceId: string
  outlet: string
  role: string
  allowedTabs?: string[]
  /** Client-side only: the outlet backend (VITE_OUTLETS name) this session was created on. */
  backendOutlet?: string
}
