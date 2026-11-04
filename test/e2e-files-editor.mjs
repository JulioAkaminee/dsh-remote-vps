#!/usr/bin/env node
// e2e: the device's file tree and preview inside the desktop window (DSH's own Files tab),
// and "Open in <editor>" opening device paths on this computer over Remote-SSH.
// Run the desktop with DSH_DEVICES_OPEN_CMD=test/fake-open.sh (records URLs instead of launching).
import fs from 'node:fs'
import { launch, shot } from './pw.mjs'
import { launchUrlFromLog, login } from './ctrl-api.mjs'

const BASE = process.env.DSHDEV_BASE || '/tmp/dshdev'
const LOG = process.env.FAKE_OPEN_LOG || `${BASE}/opened-urls.log`
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const opened = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : [])
const waitOpened = async (n, page) => {
  for (let i = 0; i < 40; i++) {
    if (opened().length > n) return opened().at(-1)
    await page.waitForTimeout(250)
  }
  return null
}
fs.writeFileSync(`${BASE}/project-on-vps/notas-da-vps.txt`, 'conteudo de teste na VPS\n')
fs.rmSync(LOG, { force: true })

const url = launchUrlFromLog(`${BASE}/ctrl.log`)
const api = await login(url)
const dev = (await api.call('GET', '/api/devices')).body.devices.find((d) => d.transport.kind === 'url')
await api.call('POST', '/api/devices/editor-host', { id: dev.id, host: '' }) // start without one: the UI must ask

const { browser, context } = await launch()
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const frameOf = () => page.frames().find((x) => x.parentFrame() === page.mainFrame() && x.url().startsWith('http') && new URL(x.url()).port !== new URL(page.url()).port)

try {
  await page.goto(url)
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 15000 }).catch(() => {})
  await page.waitForSelector('[data-dsh-devices=sidebar] [data-dshdev-device]', { timeout: 30000 })

  // 1. sidebar "Files" on the remote workspace opens DSH's Files tab with the device's tree
  const row = page.locator('[data-dsh-devices=sidebar] [role=treeitem][aria-expanded]').filter({ hasText: 'project-on-vps' }).first()
  await row.hover()
  await row.locator('[data-dshdev-action=files]').click()
  let frame
  for (let i = 0; i < 80 && !frame; i++) {
    frame = frameOf()
    if (!frame) await page.waitForTimeout(250)
  }
  await frame.waitForSelector('text=notas-da-vps.txt', { timeout: 30000 })
  check('“Files” opens the device’s file tree inside this window', true)
  await shot(page, 'fe-01-tree')

  // 2. preview a device file
  await frame.getByText('notas-da-vps.txt').first().click()
  await frame.waitForSelector('text=conteudo de teste na VPS', { timeout: 15000 })
  check('file preview shows the device file', true)

  // 3. native "Open in…" is replaced by "Open in <editor>" (no editor host yet → the desktop asks)
  await frame.waitForSelector('[data-dsh-open-editor=file]', { timeout: 15000 })
  await frame.locator('[data-dsh-open-editor=file]').first().click()
  await page.waitForSelector('[role=dialog] input', { timeout: 10000 })
  check('without an SSH host for editors the desktop asks for one', true)
  await page.waitForTimeout(600)
  const onTop = await page.evaluate(() => {
    const input = document.querySelector('[role=dialog] input')
    const r = input.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return hit === input || input.contains(hit)
  })
  check('the desktop dialog is above the embedded device UI', onTop)
  await shot(page, 'fe-02-ask-host')
  await page.locator('[role=dialog] input').fill('vps-teste')
  await page.locator('[role=dialog]').getByRole('button', { name: 'Save' }).click()
  const first = await waitOpened(0, page)
  check('preview “Open in editor” opens the file over Remote-SSH', first === 'vscode://vscode-remote/ssh-remote+vps-teste/tmp/dshdev/project-on-vps/notas-da-vps.txt', first ?? 'nothing opened')

  // 4. tree header and session header buttons open the folder
  const n1 = opened().length
  const filesTab = frame.getByRole('tab', { name: /Files/ }).first()
  if (await filesTab.count()) await filesTab.click()
  await frame.locator('[data-dsh-open-editor=folder]').first().click()
  const folder = await waitOpened(n1, page)
  check('file-tree “Open in editor” opens the workspace folder', folder === 'vscode://vscode-remote/ssh-remote+vps-teste/tmp/dshdev/project-on-vps', folder ?? 'nothing')
  const n2 = opened().length
  // With the right panel open the header is narrow and DSH tucks its utilities away; close it first.
  const collapse = frame.getByRole('button', { name: /Collapse (right )?sidebar/ }).first()
  if (await collapse.count()) await collapse.click()
  await frame.waitForTimeout(600)
  await frame.locator('[data-dsh-open-editor=session]').first().click({ timeout: 10000 })
  const sess = await waitOpened(n2, page)
  check('session header “Open in editor” opens the session folder', !!sess && sess.endsWith('/tmp/dshdev/project-on-vps'), sess ?? 'nothing')

  // 5. the desktop sidebar's editor action does the same
  const n3 = opened().length
  await row.hover()
  await row.locator('[data-dshdev-action=editor]').click()
  const side = await waitOpened(n3, page)
  check('sidebar “Open in editor” on the remote workspace', !!side && side.startsWith('vscode://vscode-remote/ssh-remote+vps-teste/'), side ?? 'nothing')
  await shot(page, 'fe-03-done')
} catch (error) {
  check('unexpected error', false, error.message.split('\n')[0])
  await shot(page, 'fe-error').catch(() => {})
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exitCode = failed ? 1 : 0
