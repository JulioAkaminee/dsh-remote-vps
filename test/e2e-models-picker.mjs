#!/usr/bin/env node
// e2e: a device without a DeepSeek key gets one from the desktop in one click,
// and new sessions can pick where they run (this computer or a device).
// Needs test/devenv.sh with the host started as `HOST_KEY= test/devenv.sh restart host`.
import { launch, shot } from './pw.mjs'
import { launchUrlFromLog, login } from './ctrl-api.mjs'

const BASE = process.env.DSHDEV_BASE || '/tmp/dshdev'
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const url = launchUrlFromLog(`${BASE}/ctrl.log`)
const api = await login(url)
const { browser, context } = await launch()
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const frameOf = () => page.frames().find((x) => x.parentFrame() === page.mainFrame() && x.url().startsWith('http://127.0.0.1:') && new URL(x.url()).port !== new URL(page.url()).port)

try {
  // reset: the device starts without a key
  const devices = (await api.call('GET', '/api/devices')).body.devices
  const dev = devices.find((d) => d.transport.kind === 'url')
  await api.call('POST', '/api/devices/model-key/clear', { id: dev.id })
  await api.call('POST', '/api/devices/refresh', { id: dev.id })

  await page.goto(url)
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(1500)

  // 1. new-session page: device pill before the workspace chooser
  await page.getByRole('button', { name: 'New session' }).first().click()
  await page.waitForSelector('[data-dsh-devices=device-pill]', { timeout: 15000 })
  const pillText = (await page.locator('[data-dsh-devices=device-pill]').innerText()).trim()
  check('new-session page shows a device picker next to the workspace chooser', !!pillText, pillText)
  await page.locator('[data-dsh-devices=device-pill]').click()
  await page.waitForSelector('.dshdev-dm', { timeout: 5000 })
  const menuText = (await page.locator('.dshdev-dm').innerText()).replace(/\n+/g, ' | ')
  check('device menu lists this computer and the devices', /VPS teste|srv/.test(menuText), menuText)
  await shot(page, 'mp-01-device-menu')

  // 2. pick the device: its new-session page opens inline with a device pill
  await page.locator('.dshdev-dm-item').filter({ hasText: dev.name }).click()
  await page.waitForFunction(() => getComputedStyle(document.getElementById('dsh-devices-frames')).display === 'block', null, { timeout: 15000 })
  let frame
  for (let i = 0; i < 60 && !frame; i++) {
    frame = frameOf()
    if (!frame) await page.waitForTimeout(250)
  }
  await frame.waitForSelector('[data-dsh-device-pill]', { timeout: 20000 })
  check('device new-session page shows the device pill', (await frame.locator('[data-dsh-device-pill]').innerText()).includes(dev.name))

  // 3. no key yet: banner offers to use this computer's key
  await page.waitForSelector('.dshdev-chat-banner [data-testid^=model-key-]', { timeout: 20000 })
  await shot(page, 'mp-02-missing-key-banner')
  check('missing model key is explained in a banner above the remote chat', true)
  await page.locator('.dshdev-chat-banner').getByRole('button', { name: /Use this computer/ }).click()
  await page.waitForFunction(() => !document.querySelector('.dshdev-chat-banner'), null, { timeout: 20000 })
  check('one click stores the desktop key on the device', true)
  const after = (await api.call('GET', '/api/devices')).body.devices.find((d) => d.id === dev.id)
  check('device reports a configured model credential', after.model && after.model.configured === true, JSON.stringify(after.model))

  // 4. the embedded UI reloads with models: pick a workspace and chat on the device
  for (let i = 0; i < 60; i++) {
    frame = frameOf()
    if (frame && (await frame.locator('[data-dsh-device-pill]').count().catch(() => 0))) break
    await page.waitForTimeout(250)
  }
  const chooser = frame.getByRole('button', { name: 'Choose workspace' }).first()
  if (((await chooser.innerText().catch(() => '')) || '').trim() === 'Choose workspace') {
    await chooser.click()
    const item = frame.locator('[role=menuitem]').filter({ hasText: 'project-on-vps' }).first()
    if (await item.count()) await item.click()
    else {
      await frame.keyboard.press('Escape')
    }
  }
  await frame.waitForTimeout(800)
  const composer = frame.locator('[contenteditable=true], textarea').first()
  await composer.click()
  await composer.pressSequentially('hello after the key was set from the desktop')
  await frame.getByRole('button', { name: 'Send message' }).click()
  let answered = false
  for (let i = 0; i < 120 && !answered; i++) {
    answered = (await frame.getByText('[VPS] MOCK-REPLY').filter({ visible: true }).count()) > 0
    if (!answered) await page.waitForTimeout(300)
  }
  check('the device agent answers once the key is set', answered)
  await shot(page, 'mp-03-answered')

  // 5. device pill inside the device UI switches back to this computer
  await page.getByRole('button', { name: 'New session' }).first().click()
  await page.waitForSelector('[data-dsh-devices=device-pill]', { timeout: 15000 })
  await page.locator('[data-dsh-devices=device-pill]').click()
  await page.locator('.dshdev-dm-item').filter({ hasText: dev.name }).click()
  await page.waitForFunction(() => getComputedStyle(document.getElementById('dsh-devices-frames')).display === 'block', null, { timeout: 15000 })
  frame = frameOf()
  await frame.waitForSelector('[data-dsh-device-pill]', { timeout: 20000 })
  await frame.locator('[data-dsh-device-pill]').click()
  await page.waitForSelector('.dshdev-dm', { timeout: 5000 })
  await page.locator('.dshdev-dm-item').first().click()
  await page.waitForFunction(() => getComputedStyle(document.getElementById('dsh-devices-frames')).display === 'none', null, { timeout: 10000 })
  check('device pill switches back to a local new session', (await page.locator('[data-dsh-devices=device-pill]').count()) > 0)

  // 6. device settings open inside the embedded UI
  await page.getByRole('button', { name: 'Devices' }).first().click()
  await page.waitForSelector(`[data-testid=device-${dev.id}]`)
  await page.locator(`[data-testid=device-${dev.id}]`).getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Device settings' }).click()
  let opened = false
  for (let i = 0; i < 40 && !opened; i++) {
    frame = frameOf()
    opened = !!frame && (await frame.locator('[role=dialog]').count().catch(() => 0)) > 0
    if (!opened) await page.waitForTimeout(250)
  }
  await shot(page, 'mp-04-device-settings')
  check('device settings open inside the embedded device UI', opened)
} catch (error) {
  check('unexpected error', false, error.message.split('\n')[0])
  await shot(page, 'mp-error').catch(() => {})
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exitCode = failed ? 1 : 0
