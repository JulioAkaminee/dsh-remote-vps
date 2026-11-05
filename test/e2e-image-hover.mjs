// Isolated browser fixture for the host enhancement; no live DSH or VPS is modified.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { launch } from './pw.mjs'

const source = fs.readFileSync(new URL('../packages/dsh-device-host/lib/client.js', import.meta.url), 'utf8')
  .replace("exports.name = 'dsh-device-host'", "exports.mountImageHover = mountImageHover; exports.name = 'dsh-device-host'")
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5y8AAAAASUVORK5CYII=', 'base64')
const { browser, context } = await launch()
try {
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const requests = []
  await page.route('http://hover.test/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/api/file')) {
      requests.push(url.href)
      return route.fulfill({ contentType: 'image/png', body: png })
    }
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><base href="http://hover.test/device-secret/"></head><body style="margin:40px;font:14px sans-serif">
      <section data-conversation-session="session-a"><div data-tool="read_image"><button id="photo" class="native_fileLink"><span>/workspace/project/images/sample.png</span></button></div></section>
      <a id="external" href="https://example.com/picture.png">external.png</a>
      </body></html>` })
  })
  await page.goto('http://hover.test/device-secret/')
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(m) { window.plugin = m.factory(() => ({})) } }
  })
  await page.addScriptTag({ content: source })
  await page.evaluate(() => {
    const sessions = { list: { getSnapshot: () => ({ byId: { 'session-a': { cwd: '/workspace/project' } } }) } }
    const uiWorkspace = { sessions, selection: { getSnapshot: () => ({ sessionId: 'session-a' }), subscribe: () => () => {} } }
    window.cleanupHover = window.plugin.mountImageHover({ uiWorkspace, sessions, get: key => key === 'sessions' ? sessions : undefined })
  })
  assert.equal(requests.length, 0, 'mount must not eagerly load files')
  await page.locator('#photo').hover()
  await page.waitForSelector('[data-dsh-image-hover][data-state="ready"] img')
  assert.equal(requests.length, 1)
  const request = new URL(requests[0])
  assert.equal(request.pathname, '/device-secret/api/file')
  assert.equal(request.searchParams.get('path'), '/workspace/project/images/sample.png')
  const bounds = await page.locator('[data-dsh-image-hover]').boundingBox()
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1360 && bounds.y + bounds.height <= 860)
  await page.mouse.move(700, 400)
  await page.waitForSelector('[data-dsh-image-hover]', { state: 'hidden' })
  await page.locator('#photo').hover()
  await page.waitForSelector('[data-dsh-image-hover][data-state="ready"] img')
  assert.equal(requests.length, 1, 'repeat hover reuses bounded cache')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-dsh-image-hover]', { state: 'hidden' })
  await page.locator('#external').hover()
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)))
  assert.equal(requests.length, 1, 'external image links do not trigger fetch')
  await page.evaluate(() => window.cleanupHover())
  assert.equal(await page.locator('[data-dsh-image-hover]').count(), 0)
  assert.deepEqual(errors, [])
  console.log('PASS: browser hover, gateway prefix, cwd, viewport, cache, Escape, external isolation, disposal')
} finally {
  await browser.close()
}
