import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:4186'
const node = JSON.stringify(process.execPath).replaceAll('\\\\', '/')
export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  workers: 1,
  use: { baseURL, trace: 'retain-on-failure', actionTimeout: 10_000 },
  projects: [
    { name: 'iPhone viewport', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium', channel: process.env.KITCHEN_TEST_CHANNEL || undefined } },
    { name: 'Desktop', use: { ...devices['Desktop Chrome'], channel: process.env.KITCHEN_TEST_CHANNEL || undefined } },
    ...(process.env.KITCHEN_TEST_WEBKIT === '1' ? [{ name: 'WebKit', use: { ...devices['iPhone 13'] } }] : []),
  ],
  webServer: {
    command: `${node} node_modules/vite/bin/vite.js build --outDir .test-dist && ${node} node_modules/vite/bin/vite.js preview --outDir .test-dist --host 127.0.0.1 --port 4186 --strictPort`,
    url: baseURL,
    timeout: 60_000,
    env: { VITE_SUPABASE_URL: baseURL, VITE_SUPABASE_PUBLISHABLE_KEY: 'local-test-key' },
  },
})
