#!/usr/bin/env node
// e2e: device health, freeing memory of idle device UIs, the automatic-update preference.
//   • the Devices card shows CPU / memory / disk of the device
//   • a device UI off screen longer than the idle time is unloaded, and comes back on click
//   • Settings → Devices has the automatic-update choice, saved on the desktop host
// Needs test/devenv.sh (host + ctrl + mocks running; ctrl paired with the host).
import { launch, shot } from './pw.mjs'
import { launchUrlFromLog, login } from './ctrl-api.mjs'

const BASE = process.env.DSHDEV_BASE || '/tmp/dshdev'
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const ctrl = await login(launchUrlFromLog(`${BASE}/ctrl.log`))
const list = (await ctrl.call('GET', '/api/devices')).body
const device = list.devices.find((d) => d.status === 'online')
check('the device reports its health (CPU, memory, disk)', !!(device && device.health && device.health.cpu && device.health.memory && device.health.disk), device && device.health ? `cpu ${device.health.cpu.percent}% mem ${device.health.memory.percent}% disk ${device.health.disk.percent}%` : 'none')

const { browser, context } = await launch()
await context.addInitScript(() => {
  localStorage.setItem('dsh-devices.settings', JSON.stringify({ sessionsPerGroup: 5, preload: false, showInSidebar: true, unloadAfterMs: 3000 }))
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const frames = () => page.locator('#dsh-devices-frames iframe').count()
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true
    await page.waitForTimeout(250)
  }
  return false
}

try {
  await page.goto(launchUrlFromLog(`${BASE}/ctrl.log`))
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 15000 }).catch(() => {})
  await page.waitForSelector('[data-dshdev-session]', { timeout: 30000 })

  // 1. health on the Devices page
  await page.getByRole('button', { name: 'Devices' }).first().click()
  const healthLine = await until(async () => /CPU \d+%.*Memory .* of .*Disk .* of /.test(await page.locator(`[data-testid=health-${device.id}]`).innerText()), 20000)
  await shot(page, 'hm-01-health')
  check('the Devices card shows CPU, memory and disk', healthLine, await page.locator(`[data-testid=health-${device.id}]`).innerText().catch(() => ''))

  // 2. an idle device UI is unloaded, and reloads when opened again
  await page.locator('[data-dshdev-session]').first().click()
  const loaded = await until(async () => (await frames()) === 1, 20000)
  check('opening a remote chat loads the device UI', loaded)
  await page.getByRole('button', { name: 'Devices' }).first().click() // off screen now
  const unloaded = await until(async () => (await frames()) === 0, 15000)
  check('a device UI off screen past the idle time is unloaded', unloaded)
  await page.locator('[data-dshdev-session]').first().click()
  const back = await until(async () => {
    const f = page.frames().find((x) => x.parentFrame() === page.mainFrame() && x.url().startsWith('http') && new URL(x.url()).port !== new URL(page.url()).port)
    return !!f && (await f.locator('[contenteditable=true], textarea').count()) > 0
  }, 30000)
  check('clicking the chat again reloads it', back)

  // 3. the automatic-update choice lives on the desktop host
  await page.locator('[data-slot="sidebar.settings"] button').first().click()
  await page.waitForTimeout(300)
  const menuItem = page.getByRole('menuitem', { name: /Settings/ })
  if (await menuItem.count()) await menuItem.first().click()
  await page.waitForSelector('[role=dialog]', { timeout: 10000 })
  await page.locator('[role=dialog]').getByText('Devices', { exact: true }).first().click()
  await page.waitForSelector('[data-testid=dsh-devices-auto-update]', { timeout: 10000 })
  await page.locator('[data-testid=dsh-devices-auto-update] button').click()
  await page.locator('[role=menu]').last().getByRole('menuitem', { name: 'Ask first' }).click()
  const saved = await until(async () => (await ctrl.call('GET', '/api/devices')).body.prefs.autoUpdate === 'ask', 5000)
  await shot(page, 'hm-02-settings')
  check('“Update devices automatically” is saved on the desktop host', saved)
  await ctrl.call('POST', '/api/devices/prefs', { autoUpdate: 'auto' })
  await page.keyboard.press('Escape')
} catch (error) {
  check('unexpected error', false, error.message.split('\n').slice(0, 2).join(' / '))
  await page.screenshot({ path: '/tmp/dshdev/shots/hm-error.png', timeout: 5000 }).catch(() => {})
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exitCode = failed ? 1 : 0
