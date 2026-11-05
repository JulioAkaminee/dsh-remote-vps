#!/usr/bin/env node
// End-to-end UI test against the local dev environment (test/devenv.sh):
// the "desktop" dsh shows local and remote chats in one sidebar, and remote
// chats run on the "device" dsh. Requires a paired device in ctrl-home.
//
//   node test/e2e-ui.mjs
import fs from 'node:fs'
import { launch, shot } from './pw.mjs'
import { launchUrlFromLog } from './ctrl-api.mjs'

const BASE = process.env.DSHDEV_BASE || '/tmp/dshdev'
fs.mkdirSync(`${BASE}/project-local`, { recursive: true })
fs.mkdirSync(`${BASE}/project-on-vps`, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const { browser, context } = await launch()
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`page: ${e}`))

async function pickWorkspace(scope, dir) {
  // Re-runs: the workspace from a previous run is already selected.
  const chooser = scope.getByRole('button', { name: 'Choose workspace' }).first()
  const label = (await chooser.innerText().catch(() => '')).trim()
  if (label && label !== 'Choose workspace') return
  await chooser.click()
  const dlg = scope.getByRole('dialog')
  await dlg.getByRole('button', { name: 'Edit path' }).click()
  const input = dlg.locator('input').first()
  await input.fill(dir)
  await input.press('Enter')
  await scope.waitForTimeout(500)
  await dlg.getByRole('button', { name: 'Open', exact: true }).click()
  await scope.waitForTimeout(1200)
}

/** Count visible replies containing `marker` (the device UI hides its own sidebar, which repeats titles). */
const visibleCount = (scope, marker) => scope.getByText(marker).filter({ visible: true }).count()
async function waitMore(scope, marker, before, timeout = 60000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if ((await visibleCount(scope, marker)) > before) return true
    await scope.waitForTimeout(300)
  }
  return false
}

async function send(scope, text) {
  const composer = scope.locator('[contenteditable=true], textarea').first()
  await composer.click()
  await composer.pressSequentially(text)
  await scope.getByRole('button', { name: 'Send message' }).click()
}

try {
  await page.goto(launchUrlFromLog(`${BASE}/ctrl.log`))
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(800)

  // 1. a local chat on the desktop
  await pickWorkspace(page, `${BASE}/project-local`)
  const localBefore = await visibleCount(page, '[DESKTOP] MOCK-REPLY')
  await send(page, 'local hello from the desktop')
  check('local chat answered by the desktop agent', await waitMore(page, '[DESKTOP] MOCK-REPLY', localBefore))

  // 2. one sidebar: local workspace + remote workspace with the remote mark
  await page.waitForSelector('[data-dsh-devices=sidebar] [data-dshdev-session]', { timeout: 30000 })
  const localRows = await page.locator('[role=tree] [role=treeitem]:not([data-dshdev-session])').count()
  const remoteRows = await page.locator('[data-dshdev-session]').count()
  const sameList = await page.evaluate(() => {
    const ours = document.querySelector('[data-dsh-devices=sidebar]')
    return !!ours && ours.parentElement === document.querySelector('[class*="regionArea"] [role=tree], [class*="regionArea"] [class*="_treeBody"] > [class*="_list"]')
  })
  check('sidebar lists local and remote chats in the same list', localRows > 0 && remoteRows > 0 && sameList, `local rows ${localRows}, remote rows ${remoteRows}`)
  await shot(page, 'e2e-01-sidebar-mixed')

  // 3. open a remote chat inline and talk to the device agent
  const t0 = Date.now()
  await page.locator('[data-dshdev-session]').first().click()
  const frame = await (async () => {
    for (let i = 0; i < 60; i++) {
      // The device iframe is a direct child of the desktop page (the device UI may nest its own frames).
      const f = page.frames().find((x) => x.parentFrame() === page.mainFrame() && x.url().startsWith('http://127.0.0.1:') && new URL(x.url()).port !== new URL(page.url()).port)
      if (f) return f
      await page.waitForTimeout(250)
    }
  })()
  check('remote chat opens inside this window (no new window)', !!frame && context.pages().length === 1, `pages ${context.pages().length}`)
  await frame.waitForSelector('[contenteditable=true], textarea', { timeout: 30000 })
  console.log(`      remote UI ready in ${Date.now() - t0} ms`)
  const sidebarHidden = await frame.evaluate(() => {
    const col = document.querySelector('[class*="_sidebarCol"]')
    return !col || getComputedStyle(col).display === 'none'
  })
  check('embedded device UI hides its own sidebar', sidebarHidden)
  await frame.waitForTimeout(800)
  const remoteBefore = await visibleCount(frame, '[VPS] MOCK-REPLY')
  await send(frame, 'remote hello, run this on the VPS')
  check('remote chat answered by the device agent', await waitMore(frame, '[VPS] MOCK-REPLY', remoteBefore))
  await shot(page, 'e2e-02-remote-inline')

  // 4. back to the local chat: the embedded device UI hides
  await page.locator('[role=tree] [role=treeitem]:not([data-dshdev-session]):not([aria-expanded])').filter({ hasNotText: 'New Session' }).first().click()
  await page.waitForTimeout(800)
  const overlayHidden = await page.evaluate(() => getComputedStyle(document.getElementById('dsh-devices-frames')).display === 'none')
  check('selecting a local chat shows the local conversation', overlayHidden && (await visibleCount(page, '[DESKTOP] MOCK-REPLY')) > 0)
  await shot(page, 'e2e-03-back-to-local')

  // 5. remote again: instant, the device UI was kept alive
  const t1 = Date.now()
  await page.locator('[data-dshdev-session]').first().click()
  await page.waitForFunction(() => getComputedStyle(document.getElementById('dsh-devices-frames')).display === 'block')
  const switchMs = Date.now() - t1
  check('switching back to a remote chat is instant', switchMs < 1500, `${switchMs} ms`)

  // 6. a new remote session from the remote workspace row
  const idsBefore = await page.locator('[data-dshdev-session]').evaluateAll((els) => els.map((e) => e.getAttribute('data-dshdev-session')))
  const projectRow = page.locator('[data-dsh-devices=sidebar] [role=treeitem][aria-expanded]').filter({ hasText: /^project-on-vps$/ }).first()
  await projectRow.hover()
  await projectRow.getByRole('button', { name: /New session (on|in) / }).click()
  await page.waitForTimeout(2500)
  await send(frame, 'second remote chat')
  await waitMore(frame, '[VPS] MOCK-REPLY', 0)
  await page.waitForFunction((ids) => [...document.querySelectorAll('[data-dshdev-session]')].some((e) => !ids.includes(e.getAttribute('data-dshdev-session'))), idsBefore, { timeout: 30000 })
  check('new remote session appears in the sidebar', true)
  await shot(page, 'e2e-04-new-remote')

  // 7. the composer's workspace chooser offers device workspaces too
  await page.getByRole('button', { name: 'New session' }).first().click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Choose workspace' }).first().click()
  await page.waitForSelector('[data-dsh-devices=workspace-menu] [role=menuitem]', { timeout: 10000 })
  await shot(page, 'e2e-05-workspace-chooser')
  await page.locator('[data-dsh-devices=workspace-menu] [role=menuitem]').filter({ hasText: 'project-on-vps' }).first().click()
  await page.waitForFunction(() => getComputedStyle(document.getElementById('dsh-devices-frames')).display === 'block', null, { timeout: 15000 })
  await frame.locator('[contenteditable=true], textarea').first().waitFor({ timeout: 20000 })
  // Wait for the new, blank session (the previous conversation may still be on screen briefly).
  for (let i = 0; i < 40 && (await visibleCount(frame, '[VPS] MOCK-REPLY')) > 0; i++) await page.waitForTimeout(250)
  const beforeMenu = await visibleCount(frame, '[VPS] MOCK-REPLY')
  check('the chooser opened a new, blank session on the device', beforeMenu === 0)
  await send(frame, 'started from the local workspace chooser')
  check('choosing a device workspace in the chooser starts the chat on the device', await waitMore(frame, '[VPS] MOCK-REPLY', beforeMenu))
} catch (error) {
  check('unexpected error', false, error.message.split('\n')[0])
  await shot(page, 'e2e-error').catch(() => {})
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exitCode = failed ? 1 : 0
