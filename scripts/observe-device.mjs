#!/usr/bin/env node
// Observe a real device host from the device itself: one line per event.
// Use it to verify, end to end, what a desktop does through dsh-devices:
//   PAIRED / ACTIVE    a desktop paired, and is polling (last seen)
//   KEY                the DeepSeek credential was stored on this device (never its value)
//   SESSION / REPLY    sessions created here and model replies landing in them
//   MODEL-ERROR        missing/invalid credential errors inside a session
//   HOST               relevant device-host log lines
//
//   node scripts/observe-device.mjs [--dsh-home ~/.dsh] [--interval 3]
// Requires Node >= 22.15 (zstd) to read session logs.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const DSH_HOME = arg('dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
const INTERVAL = Number(arg('interval', 3)) * 1000
const CLI = path.join(os.homedir(), '.dsh-device', 'bin', 'dsh-device')
const out = (line) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`)

const seenClients = new Map()
const sessions = new Map() // dir -> { replies, errors }
let keyStored = null

function clients() {
  try {
    return JSON.parse(execFileSync(CLI, ['connections', '--json'], { encoding: 'utf8' })).clients ?? []
  } catch {
    return []
  }
}

function hasKey() {
  try {
    return /DEEPSEEK_API_KEY/.test(fs.readFileSync(path.join(DSH_HOME, '.credentials.yaml'), 'utf8'))
  } catch {
    return false
  }
}

function readSession(file) {
  try {
    const raw = fs.readFileSync(file)
    const text = file.endsWith('.zstd') ? zlib.zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
    const events = []
    for (const line of text.split('\n')) {
      try {
        events.push(JSON.parse(line))
      } catch {}
    }
    return events
  } catch {
    return null
  }
}

function textOf(event) {
  const seen = []
  const walk = (v) => {
    if (seen.length > 3) return
    if (typeof v === 'string') return
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') {
      if (typeof v.text === 'string' && v.text.trim()) seen.push(v.text.trim())
      for (const k of Object.keys(v)) if (k !== 'text') walk(v[k])
    }
  }
  walk(event)
  return seen.join(' ').replace(/\s+/g, ' ').slice(0, 90)
}

function scanSessions() {
  const root = path.join(DSH_HOME, 'sessions')
  let groups = []
  try {
    groups = fs.readdirSync(root)
  } catch {
    return
  }
  for (const g of groups) {
    let dirs = []
    try {
      dirs = fs.readdirSync(path.join(root, g))
    } catch {
      continue
    }
    for (const d of dirs) {
      const dir = path.join(root, g, d)
      const file = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f))
      if (!file) continue
      let state = sessions.get(dir)
      if (!state) {
        state = { replies: 0, errors: 0, mtime: 0 }
        sessions.set(dir, state)
        out(`SESSION new: ${d} (workspace ${g.replace(/^-+|-+$/g, '').replace(/-/g, '/')})`)
      }
      const mtime = fs.statSync(file).mtimeMs
      if (mtime === state.mtime) continue
      state.mtime = mtime
      const events = readSession(file)
      if (!events) continue
      const replies = events.filter((e) => (e.type || e.event?.type) === 'assistant/message')
      for (const e of replies.slice(state.replies)) out(`REPLY in ${d}: "${textOf(e)}"`)
      state.replies = replies.length
      const errors = events.filter((e) => /MISSING_CREDENTIAL|INVALID_CREDENTIAL|model-unavailable/.test(JSON.stringify(e)))
      if (errors.length > state.errors) out(`MODEL-ERROR in ${d}: ${(JSON.stringify(errors.at(-1)).match(/MISSING_CREDENTIAL|INVALID_CREDENTIAL|model-unavailable/) ?? ['?'])[0]}`)
      state.errors = errors.length
    }
  }
}

// Device-host log lines worth seeing.
const journal = spawn('journalctl', ['--user', '-u', 'dsh-device-host', '-f', '-n', '0', '-o', 'cat'], { stdio: ['ignore', 'pipe', 'ignore'] })
let buf = ''
journal.stdout.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (/paired client|pairing refused|model credential|unpaired itself|Error|fatal/i.test(line)) out(`HOST ${line.replace(/token=\S+/g, 'token=***').slice(0, 200)}`)
  }
})

// First pass records the current state silently.
for (const c of clients()) seenClients.set(c.id, c.lastSeenAt)
keyStored = hasKey()
scanSessions()
out(`observing ${DSH_HOME}: ${seenClients.size} paired desktop(s), DeepSeek key ${keyStored ? 'present' : 'absent'}, ${sessions.size} session(s)`)

setInterval(() => {
  for (const c of clients()) {
    if (!seenClients.has(c.id)) out(`PAIRED ${c.label} (platform ${c.platform}, via ${c.pairedVia})`)
    else if (c.lastSeenAt && seenClients.get(c.id) !== c.lastSeenAt) out(`ACTIVE ${c.label} last seen ${c.lastSeenAt}`)
    seenClients.set(c.id, c.lastSeenAt)
  }
  const k = hasKey()
  if (k !== keyStored) out(`KEY ${k ? 'stored on this device (DEEPSEEK_API_KEY)' : 'removed'}`)
  keyStored = k
  scanSessions()
}, INTERVAL)
