// "Sync with device": a desktop copies its customisations here.
//
//   instructions  $DSH_HOME/AGENTS.md and <agentsHome>/AGENTS.md
//   skills        $DSH_HOME/skills/<name> and <agentsHome>/skills/<name>
//   rows          MCP servers / agent presets: profile rows kept in one managed
//                 block of this profile's cordis.patch.yml
//   plugins       third-party bundles, installed with DSH's plugin manager
//
// The desktop diffs by content hash (`contentHash` / `skillHash` in protocol.js,
// shared by both packages), so unchanged items are never sent again.

import fs from 'node:fs'
import path from 'node:path'
import { contentHash, homes, listSkillNames, MAX_SKILL_BYTES, readSkill, SAFE_SYNC_NAME, SKILL_SYNC_MARK, skillHash } from './protocol.js'

export const BLOCK_BEGIN = '# >>> dsh-devices sync: rows copied from a desktop ("Sync with device" rewrites this block) >>>'
export const BLOCK_END = '# <<< dsh-devices sync <<<'
const SKILL_MARK = SKILL_SYNC_MARK
const MAX_INSTRUCTIONS_BYTES = 512 * 1024
const MAX_TARBALL_BYTES = 40 * 1024 * 1024
const SAFE_NAME = SAFE_SYNC_NAME

/** Rows currently in the managed block (JSON per line, see `renderBlock`). */
export function readBlockRows(text) {
  const start = text.indexOf(BLOCK_BEGIN)
  const end = text.indexOf(BLOCK_END)
  if (start < 0 || end < start) return []
  const rows = []
  for (const line of text.slice(start + BLOCK_BEGIN.length, end).split('\n')) {
    const m = /^\s*-\s*(\{.*\})\s*$/.exec(line)
    if (!m) continue
    try {
      const row = JSON.parse(m[1])
      if (row && typeof row.id === 'string') rows.push(row)
    } catch {}
  }
  return rows
}

/** The managed block: one flow-style (JSON) row per line, inserted as a group. */
export function renderBlock(rows) {
  if (rows.length === 0) return ''
  const lines = [BLOCK_BEGIN, '- insert:']
  for (const row of rows) lines.push(`    - ${JSON.stringify(row)}`)
  lines.push(BLOCK_END)
  return `${lines.join('\n')}\n`
}

/** Replace (or append, or remove) the managed block in a patch file's text. */
export function writeBlock(text, rows) {
  const block = renderBlock(rows)
  const start = text.indexOf(BLOCK_BEGIN)
  const end = text.indexOf(BLOCK_END)
  if (start >= 0 && end > start) {
    const after = text.slice(end + BLOCK_END.length).replace(/^\n/, '')
    const next = `${text.slice(0, start)}${block}${after}`
    // Nothing left but comments: keep the file a valid (empty) list.
    const left = next.split('\n').some((l) => l.trim() && !l.trim().startsWith('#'))
    return left ? next : `${next.replace(/\s+$/, '')}${next.trim() ? '\n' : ''}[]\n`
  }
  if (!block) return text
  // A fresh profile holds `[]` (an empty flow list), which block rows cannot follow: drop it, keep comments.
  const meaningful = text
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .join('\n')
    .trim()
  let base = meaningful === '[]' ? text.replace(/^\s*\[\]\s*$/m, '') : text
  if (base.trim() === '') base = ''
  if (base && !base.endsWith('\n')) base += '\n'
  return `${base}${base ? '\n' : ''}${block}`
}

function safeRel(rel) {
  const p = String(rel ?? '')
  if (!p || p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => s === '..' || s === '' || s === '.')) return null
  return p
}

function writeFileAtomic(file, data, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, data, { mode })
  fs.renameSync(tmp, file)
}

export class DeviceSync {
  /**
   * @param {{ profileDir: () => string|null, loaderRowIds: () => string[], pluginManager: () => any, stateDir: string, logger: any }} options
   */
  constructor({ profileDir, loaderRowIds, pluginManager, stateDir, logger }) {
    this.profileDir = profileDir
    this.loaderRowIds = loaderRowIds
    this.pluginManager = pluginManager
    this.stateDir = stateDir
    this.logger = logger
  }

  _patchFile() {
    const dir = this.profileDir()
    return dir ? path.join(dir, 'cordis.patch.yml') : null
  }

  _readPatch() {
    const file = this._patchFile()
    if (!file) return ''
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }

  async _plugins() {
    const pm = this.pluginManager()
    if (!pm || typeof pm.listBundles !== 'function') return { available: false, items: [] }
    const bundles = await pm.listBundles()
    return {
      available: true,
      items: bundles
        .filter((b) => b.installed && b.availability === 'profile' && !b.official)
        .map((b) => ({ name: b.name, version: b.version ?? null, source: b.source ?? null, enabled: !!b.enabled, error: b.error?.code ?? null })),
    }
  }

  /** What is customised here, by hash (never the contents). */
  async state() {
    const h = homes()
    const instructions = []
    for (const [target, dir] of Object.entries(h)) {
      try {
        const text = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
        instructions.push({ target, exists: true, hash: contentHash(text), bytes: Buffer.byteLength(text) })
      } catch {
        instructions.push({ target, exists: false, hash: null, bytes: 0 })
      }
    }
    const skills = []
    for (const [root, dir] of Object.entries(h)) {
      const base = path.join(dir, 'skills')
      for (const name of listSkillNames(base)) {
        try {
          const skill = readSkill(base, name)
          if (skill) skills.push({ root, name, hash: skillHash(skill.files), synced: fs.existsSync(path.join(base, name, SKILL_MARK)) })
        } catch {}
      }
    }
    const blockRows = readBlockRows(this._readPatch())
    const plugins = await this._plugins().catch((e) => ({ available: false, items: [], error: e.message }))
    return {
      instructions,
      skills,
      rows: blockRows.map((r) => ({ id: r.id, name: r.name, hash: contentHash(JSON.stringify(r)) })),
      rowIds: this.loaderRowIds(),
      plugins: plugins.items,
      pluginManager: plugins.available,
      profile: !!this._patchFile(),
    }
  }

  /**
   * Apply a bundle. Every item reports `{ kind, name, ok, detail }`; one
   * failure never stops the rest.
   */
  async apply(bundle, { from, log = () => {} } = {}) {
    const report = []
    const done = (kind, name, ok, detail, extra = {}) => {
      report.push({ kind, name, ok, detail: detail ?? null, ...extra })
      log(`${ok ? 'ok' : 'failed'} ${kind} ${extra.root ? `${extra.root}:` : ''}${name}${detail ? `: ${detail}` : ''}`)
    }
    const h = homes()

    for (const item of Array.isArray(bundle?.instructions) ? bundle.instructions : []) {
      const dir = h[item?.target]
      if (!dir || typeof item.content !== 'string') {
        done('instructions', String(item?.target), false, 'invalid')
        continue
      }
      if (Buffer.byteLength(item.content) > MAX_INSTRUCTIONS_BYTES) {
        done('instructions', item.target, false, 'too large')
        continue
      }
      try {
        const file = path.join(dir, 'AGENTS.md')
        const backup = `${file}.before-sync`
        if (fs.existsSync(file) && !fs.existsSync(backup) && contentHash(fs.readFileSync(file, 'utf8')) !== contentHash(item.content)) {
          fs.copyFileSync(file, backup)
        }
        writeFileAtomic(file, item.content)
        done('instructions', item.target, true)
      } catch (e) {
        done('instructions', item.target, false, e.message)
      }
    }

    for (const item of Array.isArray(bundle?.skills) ? bundle.skills : []) {
      const dir = h[item?.root]
      const name = String(item?.name ?? '')
      if (!dir || !SAFE_NAME.test(name) || !Array.isArray(item.files) || item.files.length === 0) {
        done('skill', name || '?', false, 'invalid', { root: item?.root ?? null })
        continue
      }
      try {
        const base = path.join(dir, 'skills')
        const files = item.files.map((f) => ({ path: safeRel(f.path), data: Buffer.from(String(f.data ?? ''), 'base64') }))
        if (files.some((f) => !f.path)) throw new Error('invalid file path')
        if (files.reduce((n, f) => n + f.data.length, 0) > MAX_SKILL_BYTES) throw new Error('too large')
        if (item.flat) {
          if (files.length !== 1 || !name.endsWith('.md')) throw new Error('invalid flat skill')
          writeFileAtomic(path.join(base, name), files[0].data)
        } else {
          const target = path.join(base, name)
          // Backups and staging live outside the skills root, so DSH never loads them as skills.
          const aside = path.join(dir, '.dsh-devices-sync')
          if (fs.existsSync(target) && !fs.existsSync(path.join(target, SKILL_MARK))) {
            // A skill made on the device: keep it aside instead of overwriting it.
            fs.mkdirSync(path.join(aside, 'backup'), { recursive: true })
            fs.renameSync(target, path.join(aside, 'backup', `${name}-${Date.now()}`))
          }
          const staging = path.join(aside, 'staging', `${name}-${process.pid}-${Date.now()}`)
          fs.mkdirSync(staging, { recursive: true })
          for (const f of files) writeFileAtomic(path.join(staging, f.path), f.data)
          fs.writeFileSync(path.join(staging, SKILL_MARK), JSON.stringify({ from: from ?? null, at: new Date().toISOString() }))
          fs.rmSync(target, { recursive: true, force: true })
          fs.mkdirSync(base, { recursive: true })
          fs.renameSync(staging, target)
        }
        done('skill', name, true, null, { root: item.root })
      } catch (e) {
        done('skill', name, false, e.message, { root: item.root })
      }
    }

    const rows = Array.isArray(bundle?.rows) ? bundle.rows : []
    const removeRows = Array.isArray(bundle?.removeRows) ? bundle.removeRows.map(String) : []
    if (rows.length || removeRows.length) {
      const file = this._patchFile()
      if (!file) {
        for (const r of rows) done('row', String(r?.id), false, 'this device host has no profile directory')
      } else {
        const text = this._readPatch()
        const current = new Map(readBlockRows(text).map((r) => [r.id, r]))
        const foreign = new Set(this.loaderRowIds().filter((id) => !current.has(id)))
        for (const id of removeRows) current.delete(id)
        const accepted = []
        for (const r of rows) {
          if (!r || typeof r.id !== 'string' || typeof r.name !== 'string' || !SAFE_NAME.test(r.id)) {
            done('row', String(r?.id), false, 'invalid')
            continue
          }
          if (foreign.has(r.id)) {
            done('row', r.id, false, 'a row with this id already exists on the device')
            continue
          }
          const row = { id: r.id, name: r.name, ...(r.config !== undefined ? { config: r.config } : {}), ...(r.disabled ? { disabled: true } : {}) }
          current.set(r.id, row)
          accepted.push(r.id)
        }
        try {
          writeFileAtomic(file, writeBlock(text, [...current.values()]))
          for (const id of accepted) done('row', id, true)
        } catch (e) {
          for (const id of accepted) done('row', id, false, e.message)
        }
      }
    }

    const plugins = Array.isArray(bundle?.plugins) ? bundle.plugins : []
    if (plugins.length) {
      const pm = this.pluginManager()
      for (const p of plugins) {
        const name = String(p?.name ?? '')
        if (!pm || typeof pm.installBundle !== 'function') {
          done('plugin', name, false, 'plugin manager unavailable on the device')
          continue
        }
        try {
          let spec = typeof p.spec === 'string' ? p.spec.trim() : ''
          if (typeof p.tarball === 'string' && p.tarball) {
            const data = Buffer.from(p.tarball, 'base64')
            if (data.length > MAX_TARBALL_BYTES) throw new Error('package too large')
            const file = path.join(this.stateDir, 'sync', 'plugins', `${name.replace(/[^\w.-]+/g, '_')}-${String(p.version ?? 'x').replace(/[^\w.-]+/g, '_')}.tgz`)
            writeFileAtomic(file, data, 0o600)
            spec = file
          }
          if (!spec || spec.startsWith('-')) throw new Error('no installable spec')
          const installed = (await pm.listBundles()).find((b) => b.name === name && b.installed)
          if (installed && (!p.replace || (p.version && installed.version === p.version))) {
            done('plugin', name, true, `already installed (${installed.version ?? '?'})`)
            continue
          }
          const install = async (target) => {
            const result = await pm.installBundle(target)
            const status = result?.application?.status ?? result?.status ?? null
            const failed = result?.ok === false || status === 'failed' || (Array.isArray(result?.errors) && result.errors.length > 0)
            return { failed, status, detail: failed ? JSON.stringify(result?.errors ?? status).slice(0, 300) : status }
          }
          // Another version is a removal plus an installation; keep the way back.
          const previous = installed ? installed.source ?? null : null
          if (installed) {
            log(`replacing ${name} ${installed.version ?? ''} with ${p.version ?? ''}`)
            await pm.removeBundle(name)
          }
          log(`installing ${name} (${spec.startsWith('/') ? path.basename(spec) : spec})`)
          let outcome
          try {
            outcome = await install(spec)
          } catch (e) {
            outcome = { failed: true, detail: e.code ?? e.message }
          }
          if (outcome.failed && previous) {
            const back = await install(previous).catch((e) => ({ failed: true, detail: e.message }))
            outcome.detail = `${outcome.detail}; ${back.failed ? `could not restore ${installed.version ?? 'the previous version'}` : `kept ${installed.version ?? 'the previous version'}`}`
          }
          done('plugin', name, !outcome.failed, outcome.status === 'restart-required' ? 'restart the device host to activate it' : outcome.detail)
        } catch (e) {
          done('plugin', name, false, e.code ?? e.message)
        }
      }
    }
    return report
  }
}
