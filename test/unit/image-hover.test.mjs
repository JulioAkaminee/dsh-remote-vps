import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

const source = fs.readFileSync(new URL('../../packages/dsh-device-host/lib/client.js', import.meta.url), 'utf8')
  .replace('exports.apply = apply', 'exports.apply = apply; exports.test = { imagePath, imageFileUrl, imageTarget, readHoverImage, mountImageHover }')

function harness(fetcher = async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })) {
  const listeners = new Map(), timers = new Map(), revoked = [], calls = [], nodes = []
  let now = 0, next = 0, exported, selected = 'a', subscription
  const target = (name) => ({
    addEventListener(type, fn) { listeners.set(name + type, fn) },
    removeEventListener(type, fn) { assert.equal(listeners.get(name + type), fn); listeners.delete(name + type) },
  })
  const document = { ...target('doc'), baseURI: 'https://host/devices/device-a/', createElement(tag) {
    return { tagName: tag.toUpperCase(), style: {}, attrs: {}, children: [], offsetWidth: 200, offsetHeight: 160,
      setAttribute(k, v) { this.attrs[k] = v }, appendChild(n) { this.children.push(n) }, remove() { this.removed = true } }
  }, body: { appendChild(n) { nodes.push(n) } } }
  const window = { ...target('win'), location: { origin: 'https://host' }, innerWidth: 300, innerHeight: 200,
    __ModuleLoader__: { load(m) { exported = m.factory(() => { throw Error('no React') }) } } }
  class TestURL extends URL {
    static createObjectURL() { return 'blob:' + ++next }
    static revokeObjectURL(url) { revoked.push(url) }
  }
  const context = vm.createContext({ window, document, URL: TestURL, URLSearchParams, Blob, AbortController,
    Date: class extends Date { static now() { return now } },
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, at: now + ms }); return id },
    clearTimeout(id) { timers.delete(id) }, localStorage: { getItem() { return null } },
    fetch: async (...args) => { calls.push(args); return fetcher(...args) },
  })
  vm.runInContext(source, context)
  const ctx = { uiWorkspace: { selection: { getSnapshot: () => ({ sessionId: selected }), subscribe(fn) { subscription = fn; return () => { subscription = null } } },
    sessions: { list: { getSnapshot: () => ({ byId: { a: { cwd: '/work/a' }, b: { cwd: '/work/b' } } }) } } } }
  function element(path = '/work/a/picture.png', sessionId = 'a') {
    return { tagName: 'BUTTON', textContent: path, isConnected: true, dataset: { conversationSession: sessionId },
      closest(selector) { return selector === '[data-tool="read_image"]' ? {} : this },
      contains(node) { return node === this }, getBoundingClientRect() { return { left: 280, bottom: 190 } } }
  }
  return { ...exported.test, document, ctx, element, timers, nodes, calls, revoked, listeners,
    fire(type, el, extra = {}) { listeners.get('doc' + type)?.({ target: el, ...extra }) },
    switchSession() { selected = 'b'; subscription?.() },
    async tick(ms) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn() } for (let i = 0; i < 20; i++) await Promise.resolve() },
  }
}

test('paths resolve only known cwd; gateway stays device scoped', () => {
  const h = harness()
  assert.equal(h.imagePath('../image.PNG', '/work/a'), '/work/image.PNG')
  assert.equal(h.imagePath('/tmp/a b.webp'), '/tmp/a b.webp')
  for (const p of ['~/a.png', '//remote/a.png', 'https://evil/a.png', 'a.svg', 'a.png\n', 'a.png?foo']) assert.equal(h.imagePath(p, '/work'), null)
  assert.equal(h.imagePath('a.png'), null)
  assert.equal(h.imageTarget(h.element('picture.png'), '/work/a'), null, 'relative tool summary cannot reveal recorded canonical path')
  assert.equal(h.imageTarget(h.element('~/picture.png'), '/work/a'), null)
  assert.equal(h.imageTarget(h.element('/tmp/picture.png'), '/work/a').path, '/tmp/picture.png')
  assert.equal(h.imageFileUrl('/tmp/a b.png'), 'https://host/devices/device-a/api/file?path=%2Ftmp%2Fa%20b.png')
  h.document.baseURI = 'https://evil/'
  assert.equal(h.imageFileUrl('/tmp/a.png'), null)
})

test('link detection rejects arbitrary URLs but accepts identifiable local paths', () => {
  const h = harness()
  const link = (href) => ({ tagName: 'A', getAttribute: () => href, closest() { return this } })
  for (const href of ['https://evil/a.png', '//evil/a.png', 'data:image/png,x', 'https://host/other/a.png']) assert.equal(h.imageTarget(link(href), '/work'), null)
  assert.equal(h.imageTarget(link('../a.png#L20'), '/work/sub').path, '/work/a.png')
  assert.equal(h.imageTarget(link('/devices/device-a/api/file?path=%2Ftmp%2Fa.png'), '/work').path, '/tmp/a.png')
  assert.equal(h.imageTarget(link('file:///tmp/a.png'), '/work').path, '/tmp/a.png')
})

test('bounded reader rejects MIME, HTTP errors and declared or streamed overflow; cancels reader', async () => {
  for (const variant of ['mime', 'status', 'declared', 'streamed']) {
    let cancelled = false
    const h = harness(async () => ({ ok: variant !== 'status', headers: new Headers({ 'content-type': variant === 'mime' ? 'text/html' : 'image/png', 'content-length': variant === 'declared' ? '5000000' : '0' }),
      body: { getReader: () => ({ read: async () => ({ value: new Uint8Array(4 * 1024 * 1024 + 1), done: false }), cancel: async () => { cancelled = true }, releaseLock() {} }) } }))
    await assert.rejects(h.readHoverImage('https://host/api/file', new AbortController().signal))
    assert.equal(cancelled, true)
  }
})

test('hover is delayed, occurrence scoped, clamped, cached, expires and disposes listeners', async () => {
  const h = harness(), dispose = h.mountImageHover(h.ctx), el = h.element('/work/b/picture.png', 'b')
  assert.equal(h.calls.length, 0)
  h.fire('pointerover', el)
  await h.tick(199)
  assert.equal(h.calls.length, 0)
  await h.tick(1)
  assert.equal(h.calls.length, 1)
  assert.match(h.calls[0][0], /path=%2Fwork%2Fb%2Fpicture.png$/)
  assert.equal(h.calls[0][1].credentials, 'same-origin')
  assert.equal(h.calls[0][1].redirect, 'error')
  assert.equal(h.nodes[0].attrs['data-state'], 'ready')
  assert.equal(h.nodes[0].style.left, '92px')
  assert.equal(h.nodes[0].style.top, '32px')
  h.fire('pointerout', el)
  h.fire('focusin', el)
  await h.tick(200)
  assert.equal(h.calls.length, 1)
  h.fire('keydown', el, { key: 'Escape' })
  assert.equal(h.nodes.at(-1).removed, true)
  await h.tick(30000)
  assert.equal(h.revoked.length, 1)
  dispose()
  assert.equal(h.listeners.size, 0)
  assert.equal(h.timers.size, 0)
})

test('leave before delay avoids fetch; session, scroll and blur abort pending requests; stale result ignored', async () => {
  for (const cancel of ['leave', 'session', 'scroll', 'blur', 'hidden', 'dispose']) {
    let resolve
    const h = harness(() => new Promise((r) => { resolve = r })), dispose = h.mountImageHover(h.ctx), el = h.element()
    h.fire('pointerover', el)
    h.fire('pointerout', el)
    await h.tick(200)
    assert.equal(h.calls.length, 0)
    h.fire('pointerover', el)
    await h.tick(200)
    if (cancel === 'leave') h.fire('pointerout', el)
    if (cancel === 'session') h.switchSession()
    if (cancel === 'scroll') h.fire('scroll', el)
    if (cancel === 'blur') h.listeners.get('winblur')()
    if (cancel === 'hidden') { h.document.hidden = true; h.fire('visibilitychange', el) }
    if (cancel === 'dispose') dispose()
    assert.equal(h.calls[0][1].signal.aborted, true)
    resolve(new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }))
    await h.tick(0)
    assert.equal(h.nodes[0].removed, true)
    assert.equal(h.nodes[0].children.length, 0)
    if (cancel !== 'dispose') dispose()
  }
})

test('timeout and unsupported content show controlled errors', async () => {
  const h = harness((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')))))
  const dispose = h.mountImageHover(h.ctx)
  h.fire('pointerover', h.element())
  await h.tick(200)
  await h.tick(8000)
  assert.equal(h.nodes[0].attrs['data-state'], 'error')
  assert.equal(h.nodes[0].textContent, 'Image preview timed out')
  dispose()
})

test('LRU is bounded by count and byte budget, and revokes on session switch', async () => {
  for (const size of [1, 3 * 1024 * 1024]) {
    const h = harness(async () => new Response(new Uint8Array(size), { headers: { 'content-type': 'image/png' } }))
    const dispose = h.mountImageHover(h.ctx)
    for (let i = 0; i < 10; i++) {
      const el = h.element(`/work/a/${i}.png`)
      h.fire('pointerover', el)
      await h.tick(200)
      h.fire('pointerout', el)
    }
    assert.equal(h.revoked.length, size === 1 ? 2 : 8)
    h.switchSession()
    assert.equal(h.revoked.length, 10)
    dispose()
  }
})
