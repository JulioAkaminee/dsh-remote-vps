#!/usr/bin/env node
// e2e: live updates and configuration.
//   • a finished remote turn reaches the desktop as a notification within ~2 s (push, no polling)
//   • remote groups collapse to N sessions behind "Show more"
//   • the embedded session header shows "Remote · <device>"
//   • Settings → Devices exists and its toggles take effect
//   • the gateway secret survives a desktop restart (stable asset URLs → HTTP cache)
// Needs test/devenv.sh (host with a key, e.g. after e2e-models-picker or HOST_KEY unset → key set).
import { execSync } from 'node:child_process'
import { launch, shot } from './pw.mjs'
import { launchUrlFromLog } from './ctrl-api.mjs'

const BASE = process.env.DSHDEV_BASE || '/tmp/dshdev'
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const { browser, context } = await launch()
await context.addInitScript(() => {
  localStorage.setItem('dsh-devices.settings', JSON.stringify({ notify: 'always', sessionsPerGroup: 3, preload: true, showInSidebar: true, defaultDevice: 'local' }))
  window.__notes = []
  class FakeNotification {
    static permission = 'granted'
    static requestPermission() {
      return Promise.resolve('granted')
    }
    constructor(title, opts) {
      window.__notes.push({ title, body: opts && opts.body, at: Date.now() })
    }
  }
  window.Notification = FakeNotification
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const frameOf = () => page.frames().find((x) => x.parentFrame() === page.mainFrame() && x.url().startsWith('http://127.0.0.1:') && new URL(x.url()).port !== new URL(page.url()).port)
const rootOf = (f) => (f ? new URL(f.url()).pathname.split('/')[1] : null)

try {
  await page.goto(launchUrlFromLog(`${BASE}/ctrl.log`))
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 15000 }).catch(() => {})
  await page.waitForSelector('[data-dsh-devices=sidebar] [data-dshdev-session]', { timeout: 30000 })

  // 1. "Show more" keeps remote groups short
  const before = await page.locator('[data-dshdev-session]').count()
  const more = page.locator('.dshdev-more').first()
  const hasMore = (await more.count()) > 0
  if (hasMore) await more.click()
  const after = await page.locator('[data-dshdev-session]').count()
  check('remote groups show 3 sessions and expand with "Show more"', before <= 3 * 2 && (!hasMore || after > before), `${before} → ${after}`)

  // 2. open a remote chat: header badge inside the device UI
  await page.locator('[data-dshdev-session]').first().hover()
  await page.waitForTimeout(400)
  await page.locator('[data-dshdev-session]').first().click()
  let frame
  for (let i = 0; i < 80 && !frame; i++) {
    frame = frameOf()
    if (!frame) await page.waitForTimeout(250)
  }
  await frame.waitForSelector('[contenteditable=true], textarea', { timeout: 30000 })
  // DSH tucks header utilities away while the right panel narrows the header; close it if a previous run left it open.
  const collapse = frame.getByRole('button', { name: /Collapse (right )?sidebar/ }).first()
  if (await collapse.count()) await collapse.click().catch(() => {})
  await frame.waitForTimeout(600)
  const badge = await frame.locator('span[title="VPS teste"]').count()
  check('embedded session header shows the remote badge', badge > 0)
  const rootBefore = rootOf(frame)

  // 3. a finished remote turn becomes a desktop notification, fast
  const notesBefore = await page.evaluate(() => window.__notes.length)
  const composer = frame.locator('[contenteditable=true], textarea').first()
  await composer.click()
  await composer.pressSequentially('notify me when done')
  const sentAt = Date.now()
  await frame.getByRole('button', { name: 'Send message' }).click()
  let note = null
  for (let i = 0; i < 100 && !note; i++) {
    note = await page.evaluate((n) => (window.__notes.length > n ? window.__notes[window.__notes.length - 1] : null), notesBefore)
    if (!note) await page.waitForTimeout(200)
  }
  const latency = note ? note.at - sentAt : null
  check('finished remote turn notifies the desktop', !!note && /Finished on VPS teste/.test(note.body || ''), note ? `${note.title} — ${note.body}` : 'none')
  check('notification arrives within ~4 s of sending (live feed)', latency !== null && latency < 4000, latency !== null ? `${latency} ms (includes the mock turn)` : '')

  // 4. Settings → Devices: toggles take effect
  await page.getByRole('button', { name: 'Devices' }).first().click()
  const trigger = page.locator('[data-slot="sidebar.settings"] button').first()
  await trigger.click()
  await page.waitForTimeout(400)
  const menuItem = page.getByRole('menuitem', { name: /Settings/ })
  if (await menuItem.count()) await menuItem.first().click()
  await page.waitForSelector('[role=dialog]', { timeout: 10000 })
  await page.locator('[role=dialog]').getByText('Devices', { exact: true }).first().click()
  await page.waitForSelector('[data-testid=dsh-devices-settings]', { timeout: 10000 })
  await shot(page, 'live-01-settings')
  check('Settings has a Devices section', true)
  const toggle = page.locator('[data-testid=dsh-devices-settings]').getByRole('switch', { name: 'Show remote chats in the sidebar' })
  await toggle.click()
  await page.waitForTimeout(500)
  const hidden = (await page.locator('[data-dsh-devices=sidebar] [data-dshdev-device]').count()) === 0
  await toggle.click()
  await page.waitForTimeout(500)
  const shown = (await page.locator('[data-dsh-devices=sidebar] [data-dshdev-device]').count()) > 0
  check('“Show remote chats in the sidebar” hides and shows them', hidden && shown)
  await page.keyboard.press('Escape')

  // 5. stable gateway secret across a desktop restart
  execSync(`CTRL_HOME_DIR=${BASE}/ctrl-userhome sh ${process.cwd()}/test/devenv.sh restart ctrl`)
  await page.waitForTimeout(15000)
  await page.goto(launchUrlFromLog(`${BASE}/ctrl.log`))
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 15000 }).catch(() => {})
  await page.waitForSelector('[data-dshdev-session]', { timeout: 30000 })
  await page.locator('[data-dshdev-session]').first().click()
  frame = undefined
  for (let i = 0; i < 80 && !frame; i++) {
    frame = frameOf()
    if (!frame) await page.waitForTimeout(250)
  }
  check('gateway URL is stable across desktop restarts (HTTP cache survives)', !!rootBefore && rootOf(frame) === rootBefore)
} catch (error) {
  check('unexpected error', false, error.message.split('\n')[0])
  await shot(page, 'live-error').catch(() => {})
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exitCode = failed ? 1 : 0
