#!/usr/bin/env node
// e2e: the device host goes away and comes back while a remote chat is open.
//   • the device's sidebar header says "Connecting…", then "Offline"; its panels are disabled
//   • when it is back, the header clears, the open chat works again (a new message is answered)
//   • a device panel opened right after the reconnect loads (Plugins list on screen)
// Needs test/devenv.sh (host + ctrl + mocks running; ctrl paired with the host). Restarts the host.
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, shot } from './pw.mjs'
import { launchUrlFromLog } from './ctrl-api.mjs'

const BASE = process.env.DSHDEV_BASE || '/tmp/dshdev'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const host = (action) => execSync(`sh ${ROOT}/test/devenv.sh ${action} host`, { stdio: 'ignore' })

const { browser, context } = await launch()
await context.addInitScript(() => localStorage.setItem('dsh-devices.settings', JSON.stringify({ preload: false, showInSidebar: true })))
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn().catch(() => null)
    if (v) return v
    await page.waitForTimeout(400)
  }
  return null
}
const header = () => page.locator('[data-dsh-devices=sidebar] [data-dshdev-device-header]').first()
const headerState = async () => (await header().locator('.dshdev-device-state').count()) ? (await header().locator('.dshdev-device-state').innerText()).trim() : ''
const deviceFrame = () => page.frames().find((f) => f.parentFrame() === page.mainFrame() && f.url().startsWith('http') && new URL(f.url()).port !== new URL(page.url()).port)
const overlayVisible = () => page.locator('#dsh-devices-frames .dshdev-frame-overlay').evaluate((el) => el.style.display !== 'none').catch(() => false)

try {
  await page.goto(launchUrlFromLog(`${BASE}/ctrl.log`))
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 15000 }).catch(() => {})
  await page.waitForSelector('[data-dsh-devices=sidebar] [data-dshdev-session]', { timeout: 30000 })
  await page.locator('[data-dshdev-session]').first().click()
  check('a remote chat is open', !!(await until(async () => (await deviceFrame()?.locator('[contenteditable=true]').count()) > 0, 30000)))

  // 1. the device host goes away
  host('stop')
  const states = new Set()
  const offline = await until(async () => {
    const s = await headerState()
    states.add(s || 'online')
    return /offline/i.test(s)
  }, 60000)
  await shot(page, 'rc-01-offline')
  check('the device header says it is connecting, then offline', !!offline && [...states].some((s) => /connecting/i.test(s)), [...states].join(' → '))
  check('…and the section is dimmed', (await page.locator('[data-dsh-devices=sidebar] [data-dshdev-device].dshdev-device-off').count()) === 1)
  await header().locator('[data-dshdev-action=device-more]').click()
  const menu = page.locator('[role=menu]').last()
  check('device panels are disabled while it is offline', await menu.getByRole('menuitem', { name: /^Plugins$/ }).isDisabled())
  check('…and the menu offers Reconnect', (await menu.getByRole('menuitem', { name: /^Reconnect$/ }).count()) === 1)
  await page.keyboard.press('Escape')

  // 2. it comes back
  host('start')
  const back = await until(async () => (await headerState()) === '', 90000)
  check('the header clears when the device answers again', !!back)
  const usable = await until(async () => (await deviceFrame()?.locator('[contenteditable=true]').count()) > 0, 60000)
  check('the open chat is usable again', !!usable)
  const f = deviceFrame()
  await f.locator('[contenteditable=true]').first().click()
  await page.keyboard.type('after-reconnect ping')
  await page.keyboard.press('Enter')
  const replied = await until(async () => /You said:[^\n]*after-reconnect ping/.test(await f.locator('body').innerText()), 60000)
  await shot(page, 'rc-02-back')
  check('a new message in that chat is answered by the device agent', !!replied)

  // 3. a device panel right after the reconnect
  await header().locator('[data-dshdev-action=device-more]').click()
  await page.locator('[role=menu]').last().getByRole('menuitem', { name: /^Plugins$/ }).click()
  const plugins = await until(async () => /Built-in plugin settings|Installed plugins/.test(await deviceFrame().locator('body').innerText()) && !(await overlayVisible()), 45000)
  await shot(page, 'rc-03-plugins')
  check('Plugins opens with its list after the reconnect', !!plugins)
} catch (error) {
  check('unexpected error', false, error.message.split('\n').slice(0, 2).join(' / '))
  await page.screenshot({ path: `${BASE}/shots/rc-error.png`, timeout: 5000 }).catch(() => {})
  try {
    host('start')
  } catch {}
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exitCode = failed ? 1 : 0
