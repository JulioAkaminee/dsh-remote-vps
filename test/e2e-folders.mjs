#!/usr/bin/env node
// e2e: organise remote chats by project folder, the way DSH groups local ones.
//   • "Split into projects…" on a remote workspace lists its folders, project folders ticked
//   • adding them makes one group per folder under the device (empty groups show "New session")
//   • a new chat started in a project group stays in that group
//   • DSH's own "Group by" (view options) applies to remote chats: tree nests folders, single list flattens
//   • a folder can be created from the dialog; workspaces can be renamed and removed
// Needs test/devenv.sh (host + ctrl + mocks running; ctrl paired with the host).
import fs from 'node:fs'
import path from 'node:path'
import { launch, shot } from './pw.mjs'
import { launchUrlFromLog, login } from './ctrl-api.mjs'

const BASE = process.env.DSHDEV_BASE || '/tmp/dshdev'
const ROOT_WS = `${BASE}/project-on-vps`
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// Project folders inside the device's workspace (the device is this machine in the test env).
// Names are unique per run: chats of an earlier run would join a re-added folder of the same name.
const RUN = Date.now().toString(36).slice(-5)
const N = { alpha: `alpha-${RUN}`, beta: `beta-${RUN}`, gamma: `gamma-${RUN}`, delta: `delta-${RUN}` }
for (const d of fs.readdirSync(ROOT_WS)) if (/^(alpha|beta|gamma|delta)(-|$)/.test(d)) fs.rmSync(path.join(ROOT_WS, d), { recursive: true, force: true })
fs.mkdirSync(path.join(ROOT_WS, N.alpha, '.git'), { recursive: true })
fs.mkdirSync(path.join(ROOT_WS, N.beta), { recursive: true })
fs.writeFileSync(path.join(ROOT_WS, N.beta, 'package.json'), '{}')
fs.mkdirSync(path.join(ROOT_WS, N.gamma), { recursive: true })

const api = await login(launchUrlFromLog(`${BASE}/ctrl.log`))
const device = (await api.call('GET', '/api/devices')).body.devices.find((d) => d.status === 'online')
const cleanup = async () => {
  const d = (await api.call('GET', '/api/devices')).body.devices.find((x) => x.id === device.id)
  // chats this test started in its folders, then the folders' workspaces
  for (const s of d.sessions || []) if (s.cwd && s.cwd.startsWith(`${ROOT_WS}/`)) await api.call('POST', '/api/devices/session-action', { id: device.id, sessionId: s.sessionId, action: 'archive', force: true })
  for (const w of d.workspaces || []) if (w.path && w.path.startsWith(`${ROOT_WS}/`)) await api.call('POST', '/api/devices/workspace-action', { id: device.id, action: 'remove', workspaceId: w.id })
}
await cleanup()

const { browser, context } = await launch()
await context.addInitScript(() => {
  localStorage.setItem('dsh-devices.settings', JSON.stringify({ sessionsPerGroup: 3, preload: false, showInSidebar: true }))
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn().catch(() => null)
    if (v) return v
    await page.waitForTimeout(250)
  }
  return null
}
const sidebar = () => page.locator('[data-dsh-devices=sidebar]')
const groupRow = (title) => sidebar().locator('[data-dshdev-group]').filter({ hasText: new RegExp(`^${title}$`) }).first()
const groupOf = (title) => sidebar().locator('[data-dshdev-workspace]').filter({ has: page.locator('[data-dshdev-group]', { hasText: new RegExp(`^${title}$`) }) }).first()
const setGroupBy = async (mode) => {
  // DSH's own view options menu (the sliders button in the Workspaces header).
  await page.locator('[class*="_sectionHeader"] button[aria-label*="View" i], [class*="_sectionHeader"] button[aria-label*="option" i]').first().click()
  const names = { workspace: /^WorkSpace$|^Workspace$/i, 'workspace-tree': /tree/i, flat: /single|flat|list/i }
  const menu = page.locator('[role=menu]').last()
  await menu.getByRole('menuitemradio', { name: names[mode] }).or(menu.getByRole('menuitem', { name: names[mode] })).first().click()
}

try {
  await page.goto(launchUrlFromLog(`${BASE}/ctrl.log`))
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 15000 }).catch(() => {})
  await page.waitForSelector('[data-dsh-devices=sidebar] [data-dshdev-group]', { timeout: 30000 })
  await setGroupBy('workspace')
  await page.waitForTimeout(400)

  // 1. split the device's workspace into its project folders
  await groupRow('project-on-vps').hover()
  await groupRow('project-on-vps').locator('[data-dshdev-action=more]').click()
  await page.locator('[role=menu]').last().getByRole('menuitem', { name: /^Split into projects/ }).click()
  const dialog = page.locator('[data-testid=dsh-devices-folders]')
  await dialog.waitFor({ timeout: 10000 })
  await until(async () => (await dialog.locator('[data-dshdev-folder]').count()) >= 3)
  const names = await dialog.locator('[data-dshdev-folder]').evaluateAll((els) => els.map((e) => e.getAttribute('data-dshdev-folder')))
  check('“Split into projects” lists the folders inside the workspace', [N.alpha, N.beta, N.gamma].every((n) => names.includes(n)), names.join(', '))
  const ticked = await dialog.locator('.dshdev-folder-picked').evaluateAll((els) => els.map((e) => e.getAttribute('data-dshdev-folder')))
  check('…with the project folders (git, package.json) ticked', ticked.filter((n) => n.endsWith(RUN)).sort().join(',') === [N.alpha, N.beta].join(','), ticked.join(','))
  await shot(page, 'fo-01-split')
  await page.getByTestId('dsh-devices-folders-add').click()
  await dialog.waitFor({ state: 'detached', timeout: 15000 })
  const both = await until(async () => (await groupRow(N.alpha).count()) === 1 && (await groupRow(N.beta).count()) === 1)
  check('each project folder becomes a group under the device', !!both)
  check('an empty project group offers “New session”', (await groupOf(N.alpha).locator('[data-dshdev-empty-workspace]').count()) === 1)
  check('“gamma” (no project files) was left out', (await groupRow(N.gamma).count()) === 0)

  // 2. a chat started in a project stays in its group
  await page.waitForTimeout(800) // (the sidebar settles after the refresh)
  await groupRow(N.alpha).hover()
  await groupRow(N.alpha).locator('[data-dshdev-action=new]').click()
  const frame = await until(async () => page.frames().find((f) => f.parentFrame() === page.mainFrame() && f.url().startsWith('http') && new URL(f.url()).port !== new URL(page.url()).port))
  const composer = frame.locator('[contenteditable=true], textarea').first()
  await composer.waitFor({ timeout: 30000 })
  const onAlpha = await until(async () => (await frame.locator('body').innerText()).replace(/\n+/g, ' | ').includes(`| ${N.alpha} |`), 15000)
  check('the device opens a new session in that project folder', !!onAlpha)
  await page.waitForTimeout(500)
  await composer.click()
  await composer.pressSequentially(`hello from ${N.alpha}`)
  await frame.getByRole('button', { name: 'Send message' }).click()
  const inAlpha = await until(async () => (await groupOf(N.alpha).locator('[data-dshdev-session]').count()) === 1, 45000)
  await shot(page, 'fo-02-chat-in-project')
  check('a new chat started in “alpha” is listed under alpha', !!inAlpha)
  const cwd = await until(async () => {
    const d = (await api.call('GET', '/api/devices')).body.devices.find((x) => x.id === device.id)
    const s = d.sessions.find((x) => x.workspaceTitle === N.alpha)
    return s && s.cwd
  })
  check('…and runs in that folder on the device', cwd === path.join(ROOT_WS, N.alpha), cwd || 'none')

  // 3. DSH's own "Group by" applies to remote chats
  await setGroupBy('workspace-tree')
  const nested = await until(async () => (await groupOf(N.alpha).getAttribute('data-dshdev-depth')) === '1')
  await shot(page, 'fo-03-tree')
  check('“Workspace tree”: project folders nest under project-on-vps', !!nested)
  await groupRow('project-on-vps').click() // collapse the parent
  check('…and collapsing the parent hides them', !!(await until(async () => (await groupRow(N.alpha).count()) === 0)))
  await groupRow('project-on-vps').click()
  await setGroupBy('flat')
  const flatList = await until(async () => (await sidebar().locator('[data-dshdev-flat]').count()) === 1 && (await sidebar().locator('[data-dshdev-group]').count()) === 0)
  await shot(page, 'fo-04-flat')
  check('“Single list”: the device’s chats straight under it, no folders', !!flatList)
  await setGroupBy('workspace')
  await until(async () => (await groupRow(N.alpha).count()) === 1)

  // 4. create a folder from the dialog, then rename and remove workspaces
  await page.locator('[data-dsh-devices=sidebar] [data-dshdev-device-header] [data-dshdev-action=device-add-folder]').first().click()
  await dialog.waitFor({ timeout: 10000 })
  // from the home folder: up to the root, into /tmp by clicks, then the rest by typing the path
  const where = () => dialog.getByTestId('dsh-devices-folders-path').getAttribute('title')
  for (let i = 0; i < 10 && (await where()) !== '/'; i++) {
    const before = await where()
    await dialog.locator('[data-dshdev-action=folder-up]').click()
    await until(async () => (await where()) !== before)
  }
  await dialog.locator('[data-dshdev-folder="tmp"] .dshdev-folder-open').click()
  const walked = await until(async () => (await where()) === '/tmp')
  check('the folder browser walks the device’s folders (up, into)', !!walked)
  const pathField = dialog.getByTestId('dsh-devices-folders-path')
  await pathField.fill(ROOT_WS)
  await pathField.press('Enter')
  await until(async () => (await where()) === ROOT_WS)
  check('…and jumps to a typed path', (await where()) === ROOT_WS)
  await dialog.locator('input').last().fill(N.delta)
  await page.getByTestId('dsh-devices-folders-create').click()
  const created = await until(async () => (await dialog.locator(`[data-dshdev-folder="${N.delta}"].dshdev-folder-picked`).count()) === 1)
  check('“Create folder” makes it on the device and ticks it', !!created && fs.existsSync(path.join(ROOT_WS, N.delta)))
  await page.getByTestId('dsh-devices-folders-add').click()
  await dialog.waitFor({ state: 'detached', timeout: 15000 })
  check('…and it is added as a group', !!(await until(async () => (await groupRow(N.delta).count()) === 1)))
  await groupRow(N.beta).hover()
  await groupRow(N.beta).locator('[data-dshdev-action=more]').click()
  await page.locator('[role=menu]').last().getByRole('menuitem', { name: /^Rename$/ }).click()
  const field = page.locator('[role=dialog] input').last()
  await field.fill('Beta shop')
  await page.getByTestId('dsh-devices-rename-ws').click()
  check('a remote workspace can be renamed', !!(await until(async () => (await groupRow('Beta shop').count()) === 1)))
  await groupRow('Beta shop').hover()
  await groupRow('Beta shop').locator('[data-dshdev-action=more]').click()
  await page.locator('[role=menu]').last().getByRole('menuitem', { name: /^Delete workspace$|^Remove workspace$/ }).click()
  await page.getByTestId('dsh-devices-remove-ws').click()
  check('…and removed from the list (the folder stays)', !!(await until(async () => (await groupRow('Beta shop').count()) === 0)) && fs.existsSync(path.join(ROOT_WS, N.beta)))
  await shot(page, 'fo-05-done')
} catch (error) {
  check('unexpected error', false, error.message.split('\n').slice(0, 6).join(' / '))
  await page.screenshot({ path: `${BASE}/shots/fo-error.png`, timeout: 5000 }).catch(() => {})
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
await cleanup().catch(() => {})
for (const d of Object.values(N)) fs.rmSync(path.join(ROOT_WS, d), { recursive: true, force: true })
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exitCode = failed ? 1 : 0
