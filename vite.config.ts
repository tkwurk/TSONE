import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Local dev convenience: if VITE_OUTLETS isn't set (CI sets it from a GitHub
// secret), derive it from the git-ignored outlets.local.json used by
// `npm run deploy`. Only outlet names + /exec URLs reach the client.
const outletsFile = fileURLToPath(new URL('./outlets.local.json', import.meta.url))
if (!process.env.VITE_OUTLETS && existsSync(outletsFile)) {
  const raw = JSON.parse(readFileSync(outletsFile, 'utf8')) as Record<string, { deploymentId?: string }>
  process.env.VITE_OUTLETS = JSON.stringify(
    Object.entries(raw)
      .filter(([name, o]) => !name.startsWith('_') && o?.deploymentId)
      .map(([name, o]) => ({ name, url: `https://script.google.com/macros/s/${o.deploymentId}/exec` })),
  )
}

// https://vite.dev/config/
export default defineConfig({
  // Base path: '/' for local/user-pages; set BASE_PATH='/<repo>/' in CI for
  // GitHub project pages (the deploy workflow does this automatically).
  base: process.env.BASE_PATH || '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'TSONE — Point of Sale',
        short_name: 'TSONE',
        description: 'Point of sale app backed by Google Sheets via Apps Script.',
        theme_color: '#aa3bff',
        background_color: '#16171d',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
