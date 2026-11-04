#!/usr/bin/env node
// e2e: the device's tools from this computer (dsh-devices 0.1.8).
//   1. device panels: Plugins and Automations of the device, inline
//   2. "Sync with this computer": a skill and AGENTS.md reach the device
//   3. "Use this computer's account": the DeepSeek sign-in is copied to the device
//   4. "Needs you": an approval on the device marks the row and notifies here
//   5. port previews: a dev server on the device opens on this computer's localhost
//   6. search, rename, pin, archive / unarchive remote chats from the sidebar
// Needs test/devenv.sh (host + ctrl + mocks running; ctrl paired with the host).
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { launch, shot } from './pw.mjs'
import { launchUrlFromLog, login } from './ctrl-api.mjs'

const BASE = process.env.DSHDEV_BASE || '/tmp/dshdev'
const CTRL_HOME = `${BASE}/ctrl-home`
const HOST_HOME = `${BASE}/host-home`
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const stamp = Date.now().toString(36)

// ── fixtures on "this computer" (ctrl) and a clean device (host) ────────────
fs.mkdirSync(path.join(CTRL_HOME, 'skills', 'e2e-sync-skill'), { recursive: true })
fs.writeFileSync(path.join(CTRL_HOME, 'skills', 'e2e-sync-skill', 'SKILL.md'), `---\nname: e2e-sync-skill\ndescription: synced ${stamp}\n---\nSay hi.\n`)
fs.writeFileSync(path.join(CTRL_HOME, 'AGENTS.md'), `# from the desktop ${stamp}\n`)
fs.rmSync(path.join(HOST_HOME, 'skills', 'e2e-sync-skill'), { recursive: true, force: true })
const credFile = path.join(CTRL_HOME, '.credentials.yaml')
const cred = fs.readFileSync(credFile, 'utf8')
if (!cred.includes('deepseek-account-platform/default:')) {
  const block = '  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      version: 1\n      token: e2e-fake-account-token\n      issuer: http://127.0.0.1:4598\n'
  fs.writeFileSync(credFile, /\nrecords:\s*\n/.test(cred) ? `${cred.replace(/\s*$/, '\n')}${block}` : `${cred.replace(/\s*$/, '\n')}records:\n${block}`, { mode: 0o600 })
}

const ctrl = await login(launchUrlFromLog(`${BASE}/ctrl.log`))
let device = (await ctrl.call('GET', '/api/devices')).body.devices.find((d) => d.status === 'online')
if (!device) {
  console.log('FAIL  no online device paired with ctrl')
  process.exit(1)
}
await ctrl.call('POST', '/api/devices/account/clear', { id: device.id })
await ctrl.call('POST', '/api/devices/port-auto', { id: device.id, on: true })

// A dev server on the device that the agent did not start (forwarded on click).
const manualPort = 4613
const manual = http.createServer((req, res) => res.end(`manual preview ${req.url}`))
await new Promise((r) => manual.listen(manualPort, '127.0.0.1', r))

const { browser, context } = await launch()
await context.addInitScript(() => {
  localStorage.setItem('dsh-devices.settings', JSON.stringify({ notify: 'background', notifyAttention: true, sessionsPerGroup: 0, preload: true, showInSidebar: true, defaultDevice: 'local' }))
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const frameOf = () => page.frames().find((x) => x.parentFrame() === page.mainFrame() && x.url().startsWith('http') && new URL(x.url()).port !== new URL(page.url()).port)
const waitFrame = async () => {
  let f
  for (let i = 0; i < 80 && !f; i++) {
    f = frameOf()
    if (!f) await page.waitForTimeout(250)
  }
  return f
}
const until = async (fn, ms = 15000, step = 250) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn().catch(() => null)
    if (v) return v
    await page.waitForTimeout(step)
  }
  return null
}
const groupRow = () => page.locator('[data-dsh-devices=sidebar] [data-dshdev-device] [role=treeitem]').first()
const openDeviceMenu = async () => {
  await groupRow().hover()
  await page.locator('[data-dsh-devices=sidebar] [data-dshdev-action=more]').first().click()
  await page.waitForSelector('[data-dsh-devices=action-menu]', { timeout: 5000 })
}
const pickMenu = async (key) => {
  await page.locator(`[data-dsh-devices=action-menu] [data-dshdev-menu=${key}]`).click()
}
const sendInFrame = async (frame, text) => {
  const composer = frame.locator('[contenteditable=true], textarea').first()
  await composer.waitFor({ timeout: 30000 })
  await composer.click()
  await composer.pressSequentially(text)
  await frame.getByRole('button', { name: 'Send message' }).click()
}
const newRemoteSession = async () => {
  await groupRow().hover()
  await page.locator('[data-dsh-devices=sidebar] [data-dshdev-device] button[aria-label^="New session on"]').first().click()
  const f = await waitFrame()
  await f.waitForSelector('[contenteditable=true], textarea', { timeout: 30000 })
  await page.waitForTimeout(800)
  return f
}

try {
  await page.goto(launchUrlFromLog(`${BASE}/ctrl.log`))
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 15000 }).catch(() => {})
  await page.waitForSelector('[data-dsh-devices=sidebar] [data-dshdev-session]', { timeout: 30000 })

  // ── 1. device panels ──────────────────────────────────────────────────────
  await openDeviceMenu()
  const menuKeys = await page.locator('[data-dsh-devices=action-menu] [data-dshdev-menu]').evaluateAll((els) => els.map((e) => e.getAttribute('data-dshdev-menu')))
  check('device menu offers plugins, automations, ports, sync, account and search', ['plugins', 'automations', 'ports', 'sync', 'account', 'search'].every((k) => menuKeys.includes(k)), menuKeys.join(','))
  await pickMenu('plugins')
  let frame = await waitFrame()
  const pluginsShown = await until(async () => (await frame.locator('main, body').first().innerText()).match(/Plug-?ins?/i) && (await frame.locator('[contenteditable=true]').count()) === 0)
  await shot(page, 'tools-01-plugins')
  check('the device’s Plugins panel opens inline', !!pluginsShown)
  check('…labelled with the device it belongs to', (await page.locator('[data-testid=dsh-devices-panel-context]').innerText().catch(() => '')).includes(device.name))
  await openDeviceMenu()
  await pickMenu('automations')
  const automationsShown = await until(async () => /Automation|Schedule|automação/i.test(await frame.locator('body').innerText()) && (await frame.locator('[contenteditable=true]').count()) === 0)
  await shot(page, 'tools-02-automations')
  check('the device’s Automations panel opens inline', !!automationsShown)
  // a remote chat replaces the panel again
  await page.locator('[data-dshdev-session]').first().click()
  check('opening a remote chat leaves the device panel', !!(await until(async () => (await frame.locator('[contenteditable=true], textarea').count()) > 0)))

  // ── 6. search, rename, pin, archive ───────────────────────────────────────
  await openDeviceMenu()
  await pickMenu('search')
  await page.waitForSelector('[data-testid=dsh-devices-search]', { timeout: 5000 })
  await page.locator('[data-testid=dsh-devices-search] input').fill('notify me')
  const hit = await until(async () => (await page.locator('[data-testid=dsh-devices-search] [data-dshdev-result]').count()) > 0, 15000)
  await shot(page, 'tools-03-search')
  check('search finds remote chats by message content', !!hit)
  if (hit) {
    const target = await page.locator('[data-testid=dsh-devices-search] [data-dshdev-result]').first().getAttribute('data-dshdev-result')
    await page.locator('[data-testid=dsh-devices-search] [data-dshdev-result]').first().click()
    const opened = await until(async () => (await page.locator(`[data-dshdev-session="${target}"][aria-selected=true]`).count()) > 0, 10000)
    check('a search result opens that chat', !!opened)
  }

  const rowId = await page.locator('[data-dshdev-session]').nth(1).getAttribute('data-dshdev-session')
  const row = () => page.locator(`[data-dshdev-session="${rowId}"]`)
  const sessionMenu = async (key) => {
    await row().hover()
    await row().locator('[data-dshdev-action=session-more]').click()
    await page.waitForSelector('[data-dsh-devices=action-menu]', { timeout: 5000 })
    await pickMenu(key)
  }
  const newTitle = `Renamed on the Mac ${stamp}`
  await sessionMenu('rename')
  await page.locator('[role=dialog] input').last().fill(newTitle)
  await page.keyboard.press('Enter')
  check('rename a remote chat from the sidebar', !!(await until(async () => ((await row().textContent()) || '').includes(newTitle), 10000)))
  await sessionMenu('pin')
  const pinned = await until(async () => (await row().getAttribute('data-dshdev-pinned')) === '1', 10000)
  const firstInGroup = await page.evaluate((id) => {
    const el = document.querySelector(`[data-dshdev-session="${id}"]`)
    return el && el.parentElement.querySelector('[data-dshdev-session]') === el
  }, rowId)
  await shot(page, 'tools-04-pinned')
  check('pin a remote chat: pin mark, first in its group', !!pinned && firstInGroup)
  await sessionMenu('pin') // unpin
  await until(async () => (await row().getAttribute('data-dshdev-pinned')) !== '1', 10000)
  await sessionMenu('archive')
  const gone = await until(async () => (await row().count()) === 0, 10000)
  check('archive a remote chat: it leaves the sidebar', !!gone)
  await openDeviceMenu()
  await pickMenu('archived')
  await page.waitForSelector('[data-testid=dsh-devices-archived]', { timeout: 5000 })
  await shot(page, 'tools-05-archived')
  await page.locator('[data-testid=dsh-devices-archived] .dshdev-list-row', { hasText: newTitle }).getByRole('button').click()
  const back = await until(async () => (await row().count()) > 0, 10000)
  check('unarchive brings it back', !!back)
  await page.keyboard.press('Escape')

  // ── 4. "needs you" ─────────────────────────────────────────────────────────
  frame = await newRemoteSession()
  await sendInFrame(frame, 'NEED-APPROVAL')
  await page.getByRole('button', { name: 'Devices' }).first().click() // look elsewhere
  const waitingRow = await until(async () => (await page.locator('[data-dshdev-pending=approval]').count()) > 0, 20000)
  const note = await until(async () => (await page.locator('[data-dshdev-note=attention]').count()) > 0, 10000)
  await shot(page, 'tools-06-needs-you')
  check('an approval on the device marks the remote row “Needs you”', !!waitingRow)
  check('…and notifies here while you look elsewhere', !!note)
  const badge = await page.locator('[data-dsh-devices=sidebar] [data-dshdev-waiting]').count()
  check('the remote group shows how many chats need you', badge > 0)
  if (note) {
    await page.locator('[data-dshdev-note=attention]').getByRole('button').first().click()
    frame = await waitFrame()
    const allow = frame.getByRole('button', { name: /Allow once/i })
    await allow.waitFor({ timeout: 15000 })
    await allow.click()
    const cleared = await until(async () => (await page.locator('[data-dshdev-pending]').count()) === 0, 20000)
    check('approving on the device clears “Needs you”', !!cleared)
  }
  frame = await newRemoteSession()
  await sendInFrame(frame, 'ASK-QUESTION')
  const question = await until(async () => (await page.locator('[data-dshdev-pending=question]').count()) > 0, 20000)
  await shot(page, 'tools-07-question')
  check('a question from the agent also marks the row', !!question)
  if (question) {
    await frame.getByText('Blue', { exact: true }).first().click().catch(() => {})
    const submit = frame.getByRole('button', { name: /Submit|Send|Answer|Confirm/i }).last()
    if (await submit.count()) await submit.click().catch(() => {})
    await until(async () => (await page.locator('[data-dshdev-pending=question]').count()) === 0, 15000)
  }

  // ── 5. port previews ───────────────────────────────────────────────────────
  await openDeviceMenu()
  await pickMenu('ports')
  await page.waitForSelector('[data-testid=dsh-devices-ports]', { timeout: 5000 })
  const listed = await until(async () => (await page.locator(`[data-dshdev-port="${manualPort}"]`).count()) > 0, 15000)
  check('a dev server on the device is listed under Ports & previews', !!listed)
  // (a manual forward from an earlier run stays, like VS Code's)
  const forwardBtn = page.locator(`[data-dshdev-port="${manualPort}"]`).getByRole('button', { name: /^Forward$/ })
  if (await forwardBtn.count()) await forwardBtn.click()
  const localText = await until(async () => {
    const t = await page.locator(`[data-dshdev-port="${manualPort}"]`).innerText()
    return /localhost:(\d+)/.test(t) ? t : null
  }, 10000)
  const localPort = localText ? Number(localText.match(/localhost:(\d+)/)[1]) : null
  await shot(page, 'tools-08-ports')
  const body = localPort ? await fetch(`http://127.0.0.1:${localPort}/hello`).then((r) => r.text()).catch((e) => e.message) : ''
  check('forwarded: the device’s server answers on this computer’s localhost', body === 'manual preview /hello', `localhost:${localPort} → ${body}`)
  await page.keyboard.press('Escape')
  // links to localhost:<device port> inside the device UI go to the forwarded port
  await page.locator('[data-dshdev-session]').first().click()
  frame = await waitFrame()
  await frame.waitForSelector('[contenteditable=true], textarea', { timeout: 30000 })
  const rewritten = await until(
    () =>
      frame.evaluate((p) => {
        let a = document.getElementById('e2e-link')
        if (!a) {
          a = document.createElement('a')
          a.id = 'e2e-link'
          a.textContent = 'preview'
          document.body.appendChild(a)
          a.addEventListener('click', (e) => e.preventDefault())
        }
        a.setAttribute('href', `http://localhost:${p}/x`)
        a.click()
        const href = a.getAttribute('href')
        return href.includes(`:${p}/`) ? null : href
      }, manualPort),
    8000,
  )
  check('a localhost link in a remote chat points to the forwarded port', !!rewritten && rewritten.includes(`localhost:${localPort}/x`), String(rewritten))
  // a server the agent starts in the workspace is forwarded automatically, with a notice
  const agentPort = 4614
  frame = await newRemoteSession()
  await sendInFrame(frame, `START-SERVER ${agentPort}`)
  const portNote = await until(async () => (await page.locator('[data-dshdev-note=info]', { hasText: `${agentPort}` }).count()) > 0, 25000)
  await shot(page, 'tools-09-port-note')
  check('a server started by the agent is forwarded automatically, with a notice', !!portNote)

  // ── 2. sync ────────────────────────────────────────────────────────────────
  await openDeviceMenu()
  await pickMenu('sync')
  await page.waitForSelector('[data-testid=dsh-devices-sync]', { timeout: 20000 })
  const skillItem = page.locator('[data-dshdev-sync="skill:dsh:e2e-sync-skill"] input[type=checkbox]')
  const instrItem = page.locator('[data-dshdev-sync="instructions:dsh"] input[type=checkbox]')
  const preselected = (await skillItem.isChecked().catch(() => false)) && (await instrItem.isChecked().catch(() => false))
  await shot(page, 'tools-10-sync-plan')
  check('sync plan preselects the new skill and the changed AGENTS.md', preselected)
  await page.locator('[data-testid=dsh-devices-sync] input[type=checkbox]:checked').evaluateAll((els) =>
    els.forEach((el) => {
      const key = el.closest('[data-dshdev-sync]').getAttribute('data-dshdev-sync')
      if (key !== 'skill:dsh:e2e-sync-skill' && key !== 'instructions:dsh') el.click()
    }),
  )
  await page.locator('[data-testid=dsh-devices-sync-run]').click()
  const synced = await until(async () => /Synced|sincronizados/.test(await page.locator('[role=dialog]').last().innerText()), 60000)
  await shot(page, 'tools-11-sync-done')
  const skillOnDevice = fs.existsSync(path.join(HOST_HOME, 'skills', 'e2e-sync-skill', 'SKILL.md')) && fs.readFileSync(path.join(HOST_HOME, 'skills', 'e2e-sync-skill', 'SKILL.md'), 'utf8').includes(stamp)
  const agentsOnDevice = fs.existsSync(path.join(HOST_HOME, 'AGENTS.md')) && fs.readFileSync(path.join(HOST_HOME, 'AGENTS.md'), 'utf8').includes(stamp)
  check('sync copies the skill and AGENTS.md to the device', !!synced && skillOnDevice && agentsOnDevice)
  await page.keyboard.press('Escape')

  // ── 3. account ─────────────────────────────────────────────────────────────
  const local = (await ctrl.call('GET', '/api/devices/local-account')).body
  check('this computer’s DeepSeek sign-in is detected', local.available === true)
  await openDeviceMenu()
  await pickMenu('account')
  await page.waitForSelector('[data-testid=dsh-devices-account]', { timeout: 5000 })
  const useAccount = page.locator('[data-testid=dsh-devices-account]').getByRole('button', { name: /Use this computer’s account/ })
  await until(async () => (await useAccount.count()) > 0, 70000) // the browser re-reads it at most every minute
  await useAccount.first().click()
  const accountOk = await until(async () => (await page.locator(`[data-testid=account-ok-${device.id}]`).count()) > 0, 15000)
  await shot(page, 'tools-12-account')
  const hostCred = fs.readFileSync(path.join(HOST_HOME, '.credentials.yaml'), 'utf8')
  check('“Use this computer’s account” signs the device in', !!accountOk && hostCred.includes('deepseek-account-platform/default'))
  await page.keyboard.press('Escape')
} catch (error) {
  check('unexpected error', false, error.message.split('\n')[0])
  await shot(page, 'tools-error').catch(() => {})
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
manual.close()
// stop the server the mock agent started on the device
try {
  const { execSync } = await import('node:child_process')
  const out = execSync("ss -ltnpH 'sport = :4614'", { encoding: 'utf8' })
  for (const m of out.matchAll(/pid=(\d+)/g)) process.kill(Number(m[1]))
} catch {}
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exitCode = failed ? 1 : 0
