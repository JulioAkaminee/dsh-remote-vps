import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

function harness() {
  const loaded = [], requests = []
  const el = () => {
    const e = { style: {}, children: [], isConnected: true, setAttribute() {}, appendChild(x) { this.children.push(x) }, remove() { this.removed = true }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], contains: () => false, classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), contentWindow: { messages: [], postMessage(m) { this.messages.push(m) } } }
    return e
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: m => loaded.push(m) }, location: { search: '', pathname: '/', hash: '' }, addEventListener() {} },
    document: { createElement: el, body: el(), head: el(), documentElement: el(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {} }, navigator: { platform: '' },
    MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1, clearTimeout() {}, URLSearchParams, console,
    fetch: (url, init) => new Promise((resolve, reject) => requests.push({ id: JSON.parse(init.body).id, resolve: () => resolve({ ok: true, json: async () => ({ url: `http://gateway/${JSON.parse(init.body).id}/` }) }), reject })),
  }
  vm.runInNewContext(fs.readFileSync(new URL('../../packages/dsh-devices/lib/client.js', import.meta.url), 'utf8'), sandbox)
  const effects = []
  const react = { createElement: () => null, useSyncExternalStore() {}, useRef: () => ({ current: null }), useLayoutEffect() {}, useEffect: f => effects.push(f) }
  const mod = loaded[0].factory(id => id === 'react' ? react : id === 'react-dom/client' ? { createRoot: () => ({ render() {} }) } : {})
  const { frames, store } = mod.__test
  frames.renderStatus = () => {}
  frames.attach(el())
  const show = (id, sessionId) => {
    store.selection = { deviceId: id, sessionId }
    return frames.show(id, { id, name: id }, { type: 'open-session', sessionId })
  }
  const finish = id => requests.find(r => r.id === id).resolve()
  const session = (id, sessionId) => frames.onMessage({ source: frames.byDevice.get(id).iframe.contentWindow, data: { source: 'dsh-device-host', type: 'session', sessionId } })
  const returnToRemote = () => {
    store.activePanel = 'dsh-devices-chat'
    mod.__test.components.RemoteChatPanel({ t: k => k })
    for (const effect of effects.splice(0)) effect()
  }
  return { frames, store, show, finish, session, requests, returnToRemote }
}

test('slow A cannot replace fast B or boot its stale command', async () => {
  const h = harness()
  const a = h.show('a', 'old'), b = h.show('b', 'latest')
  h.finish('b'); await b
  h.finish('a'); await a
  assert.equal(h.frames.active, 'b')
  assert.equal(h.frames.byDevice.get('b').iframe.style.display, 'block')
  assert.notEqual(h.frames.byDevice.get('a').iframe.style.display, 'block')
  assert.equal(new URL(h.frames.byDevice.get('a').iframe.src).searchParams.has('dsh-session'), false)
})

test('same-device creation runs only the newest command with one resident iframe', async () => {
  const h = harness()
  const first = h.show('a', 'old'), second = h.show('a', 'latest')
  h.finish('a'); await Promise.all([first, second])
  assert.equal(h.requests.length, 1)
  const f = h.frames.byDevice.get('a')
  assert.notEqual(new URL(f.iframe.src).searchParams.get('dsh-session'), 'old')
  h.frames.onReady('a', { announced: false })
  assert.deepEqual(f.iframe.contentWindow.messages.map(m => m.sessionId), ['latest'])
})

test('preload and foreground creation share a frame without replaying old navigation', async () => {
  const h = harness()
  const preload = h.frames.preload('a', { name: 'a' })
  const old = h.show('a', 'old'), latest = h.show('a', 'latest')
  h.finish('a'); await Promise.all([preload, old, latest])
  h.frames.onReady('a', { announced: false })
  assert.deepEqual(h.frames.byDevice.get('a').iframe.contentWindow.messages.map(m => m.sessionId), ['latest'])
  assert.equal(h.frames.active, 'a')
})

test('local detach cancels pending activation but retains resident frames', async () => {
  const h = harness()
  const pending = h.show('a', 'old')
  h.frames.detach(h.frames.placeholder)
  h.finish('a'); await pending
  assert.equal(h.frames.active, null)
  assert.equal(h.frames.host.style.display, 'none')
  assert.equal(new URL(h.frames.byDevice.get('a').iframe.src).searchParams.has('dsh-session'), false)
})

test('drop invalidates pending creation', async () => {
  const h = harness()
  const pending = h.show('a', 'old')
  h.frames.drop('a')
  h.finish('a'); await pending
  assert.equal(h.frames.byDevice.has('a'), false)
  assert.equal(h.frames.active, null)
})

test('boot session reports cannot overwrite requested selection; confirmed navigation can', async () => {
  const h = harness()
  const preload = h.frames.preload('a', { name: 'a' })
  h.finish('a'); await preload
  await h.show('a', 'latest')
  h.session('a', 'old')
  assert.equal(h.store.selection.sessionId, 'latest')
  h.frames.onReady('a', { announced: false })
  h.session('a', 'old')
  assert.equal(h.store.selection.sessionId, 'latest')
  h.session('a', 'latest')
  h.session('a', 'user-picked')
  assert.equal(h.store.selection.sessionId, 'user-picked')
})

test('reopening the already-current resident session needs no duplicate confirmation', async () => {
  const h = harness()
  const a = h.show('a', 'current')
  h.finish('a'); await a
  h.frames.onReady('a', { announced: false })
  h.session('a', 'current')
  h.frames.hide()
  await h.show('a', 'current')
  // The host reports only changes: reopening current sends no second confirmation.
  h.session('a', 'user-picked')
  assert.equal(h.store.selection.sessionId, 'user-picked')
})

test('resident switching is immediate and queued stale commands are discarded', async () => {
  const h = harness()
  const a = h.frames.preload('a', { name: 'a' }), b = h.frames.preload('b', { name: 'b' })
  h.finish('a'); h.finish('b'); await Promise.all([a, b])
  const resident = h.frames.byDevice.get('a').iframe
  await h.show('a', 'old')
  await h.show('b', 'b-session')
  const latest = h.show('a', 'latest')
  assert.equal(h.frames.active, 'a')
  await latest
  h.frames.onReady('a', { announced: false })
  assert.equal(h.frames.byDevice.get('a').iframe, resident)
  assert.equal(h.requests.length, 2)
  assert.deepEqual(resident.contentWindow.messages.map(m => m.sessionId), ['latest'])
})

test('background preload never steals an existing foreground selection', async () => {
  const h = harness()
  const a = h.show('a', 'selected')
  h.finish('a'); await a
  const b = h.frames.preload('b', { name: 'b' })
  h.finish('b'); await b
  assert.equal(h.frames.active, 'a')
  assert.equal(h.frames.byDevice.get('a').iframe.style.display, 'block')
  h.session('b', 'background-session')
  assert.equal(h.store.selection.sessionId, 'selected')
})

for (const panel of [null, 'plugins']) test(`return to remote restores cancelled ${panel ? 'panel' : 'session'} on resident iframe`, async () => {
  const h = harness()
  const device = { id: 'a', name: 'a', status: 'online', panels: 'ack' }
  h.store.data.devices = [device]
  const preload = h.frames.preload('a', device)
  h.finish('a'); await preload
  const f = h.frames.byDevice.get('a')
  if (panel) {
    h.store.selection = { deviceId: 'a', panel }
    h.frames.openPanel(device, panel)
  } else await h.show('a', 'selected')
  h.store.activePanel = 'local'
  h.frames.hide()
  h.frames.onReady('a', { announced: false })
  assert.equal(f.iframe.contentWindow.messages.length, 0)
  h.returnToRemote()
  assert.equal(h.frames.byDevice.get('a'), f)
  assert.equal(h.requests.length, 1)
  assert.equal(f.iframe.contentWindow.messages.length, 1)
  assert.equal(f.iframe.contentWindow.messages[0].type, panel ? 'open-panel' : 'open-session')
  assert.equal(panel ? f.iframe.contentWindow.messages[0].panel : f.iframe.contentWindow.messages[0].sessionId, panel || 'selected')
})

test('hide cancels queued navigation without unloading a resident iframe', async () => {
  const h = harness()
  const a = h.frames.preload('a', { name: 'a' })
  h.finish('a'); await a
  const f = h.frames.byDevice.get('a')
  await h.show('a', 'cancelled')
  h.frames.hide()
  h.frames.onReady('a', { announced: false })
  assert.equal(f.iframe.contentWindow.messages.length, 0)
  assert.equal(h.frames.byDevice.get('a'), f)
  assert.equal(h.frames.host.style.display, 'none')
  h.session('a', 'stale-local-report')
  assert.equal(h.store.selection.sessionId, 'cancelled')
})
