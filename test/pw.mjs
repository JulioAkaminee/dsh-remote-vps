// Shared Playwright bootstrap for the UI tests (playwright-core + local Chromium).
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(process.env.PW_TOOLS || '/tmp/pwtools/')
const { chromium } = require('playwright-core')

export const SHOTS = process.env.SHOTS || '/tmp/dshdev/shots'
fs.mkdirSync(SHOTS, { recursive: true })

export async function launch() {
  const executablePath =
    process.env.CHROME ||
    `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 })
  return { browser, context }
}

export async function shot(page, name) {
  const file = `${SHOTS}/${name}.png`
  await page.screenshot({ path: file })
  return file
}
