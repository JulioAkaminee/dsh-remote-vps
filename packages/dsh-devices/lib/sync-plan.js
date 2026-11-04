// "Sync with device", desktop side: what this computer has customised, how it
// compares with a device (by content hash), and the bundle sent for the items
// the user picked.
//
//   instructions  ~/.dsh/AGENTS.md, ~/.agents/AGENTS.md
//   skills        ~/.dsh/skills/*, ~/.agents/skills/*
//   rows          MCP servers (every dsh-mcp-client row) and agent presets
//                 defined in this profile's own cordis.patch.yml
//   plugins       third-party bundles of this profile (not desktop-only ones)

import fs from 'node:fs'
import path from 'node:path'
import { contentHash, homes, listSkillNames, readSkill, skillHash } from './protocol.js'

const MCP_PACKAGE = '@deepseek-ai/dsh-mcp-client'
const PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset'
const MAX_TARBALL_BYTES = 40 * 1024 * 1024

/** Plugins that only make sense on a desktop (windows, tray, pets…) or are this pair itself. */
export const DESKTOP_ONLY = /(^|[-/@])(tauri|electron|desktop|pet|pets|window|windows|tray|menubar|dock|notch|devices|device-host)(?=[-/]|$)/i

export function isDesktopOnly(name, description = '') {
  return DESKTOP_ONLY.test(String(name)) || /\b(desktop[- ]only|only on (the )?desktop|tauri|electron)\b/i.test(String(description))
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Where a recorded dependency spec points: a local tarball, a local folder, or something the device can fetch itself. */
export function classifySpec(source, profileDir) {
  const spec = String(source ?? '').trim()
  if (!spec) return { kind: 'unknown' }
  let local = null
  if (/^file:/.test(spec)) local = spec.replace(/^file:(\/\/)?/, '')
  else if (/^link:/.test(spec)) return { kind: 'link' }
  else if (spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('~/')) local = spec
  if (local !== null) {
    if (local.startsWith('~/')) local = path.join(process.env.HOME || '', local.slice(2))
    const abs = path.isAbsolute(local) ? local : path.resolve(profileDir || process.cwd(), local)
    try {
      const st = fs.statSync(abs)
      if (st.isFile() && /\.(tgz|tar\.gz)$/i.test(abs)) return { kind: 'tarball', file: abs, size: st.size }
      if (st.isDirectory()) return { kind: 'folder', file: abs }
    } catch {}
    return { kind: 'missing', file: abs }
  }
  return { kind: 'remote', spec }
}

/** Rows to offer: every MCP server, plus agent presets this profile defines itself. */
export function collectRows(loaderEntries, profilePatchText) {
  const ownIds = new Set()
  for (const m of String(profilePatchText ?? '').matchAll(/^\s*-?\s*id:\s*['"]?([\w.@+-]+)['"]?\s*$/gm)) ownIds.add(m[1])
  const rows = []
  const seen = new Set()
  for (const entry of loaderEntries ?? []) {
    const o = entry?.options ?? entry
    if (!o || typeof o.id !== 'string' || typeof o.name !== 'string' || seen.has(o.id)) continue
    const isMcp = o.name === MCP_PACKAGE
    const isPreset = o.name === PRESET_PACKAGE && ownIds.has(o.id)
    if (!isMcp && !isPreset) continue
    if (o.disabled === true) continue
    let config
    try {
      config = o.config === undefined ? undefined : JSON.parse(JSON.stringify(o.config))
    } catch {
      continue
    }
    seen.add(o.id)
    rows.push({ id: o.id, name: o.name, ...(config !== undefined ? { config } : {}), kind: isMcp ? 'mcp' : 'preset' })
  }
  return rows
}

function rowWarnings(row) {
  const text = JSON.stringify(row.config ?? {})
  const warn = []
  if (/"(env|headers)"\s*:\s*\{\s*"/.test(text)) warn.push('secrets')
  if (/"\/(Users|Applications|Volumes)\//.test(text) || /[A-Z]:\\\\/.test(text)) warn.push('local-path')
  return warn
}

/** Everything this computer could send. Contents are read later, only for picked items. */
export async function collectLocal({ loaderEntries = [], profileDir = null, pluginManager = null } = {}) {
  const h = homes()
  const instructions = []
  for (const [target, dir] of Object.entries(h)) {
    const file = path.join(dir, 'AGENTS.md')
    const text = readText(file)
    if (text !== null && text.trim()) instructions.push({ target, file, hash: contentHash(text), bytes: Buffer.byteLength(text) })
  }
  const skills = []
  for (const [root, dir] of Object.entries(h)) {
    const base = path.join(dir, 'skills')
    for (const name of listSkillNames(base)) {
      try {
        const skill = readSkill(base, name)
        if (skill) skills.push({ root, name, flat: skill.flat, hash: skillHash(skill.files), files: skill.files.length, bytes: skill.files.reduce((n, f) => n + f.data.length, 0) })
      } catch (e) {
        skills.push({ root, name, error: e.message })
      }
    }
  }
  const patchText = profileDir ? readText(path.join(profileDir, 'cordis.patch.yml')) : null
  const rows = collectRows(loaderEntries, patchText).map((r) => ({ ...r, hash: contentHash(JSON.stringify({ id: r.id, name: r.name, ...(r.config !== undefined ? { config: r.config } : {}) })) }))
  let plugins = []
  if (pluginManager && typeof pluginManager.listBundles === 'function') {
    try {
      plugins = (await pluginManager.listBundles())
        .filter((b) => b.installed && b.availability === 'profile' && !b.official)
        .map((b) => ({ name: b.name, version: b.version ?? null, description: b.description ?? '', source: b.source ?? null, desktopOnly: isDesktopOnly(b.name, b.description) }))
    } catch {}
  }
  return { instructions, skills, rows, plugins }
}

/**
 * Compare with the device's `/sync` state.
 * @returns {{ key: string, kind: string, label: string, detail: string, status: 'new'|'changed'|'same'|'unsupported'|'conflict', reason?: string, warn?: string[], selected: boolean }[]}
 */
export function planSync(local, device, { profileDir = null } = {}) {
  const items = []
  const add = (item) => items.push({ ...item, selected: item.status === 'new' || item.status === 'changed' })
  for (const i of local.instructions) {
    const remote = (device.instructions ?? []).find((x) => x.target === i.target)
    add({
      key: `instructions:${i.target}`,
      kind: 'instructions',
      label: i.target === 'dsh' ? '~/.dsh/AGENTS.md' : '~/.agents/AGENTS.md',
      detail: `${Math.max(1, Math.round(i.bytes / 1024))} KB`,
      status: !remote?.exists ? 'new' : remote.hash === i.hash ? 'same' : 'changed',
    })
  }
  for (const s of local.skills) {
    const remote = (device.skills ?? []).find((x) => x.root === s.root && x.name === s.name)
    add({
      key: `skill:${s.root}:${s.name}`,
      kind: 'skill',
      label: s.name.replace(/\.md$/, ''),
      detail: `${s.root === 'dsh' ? '~/.dsh/skills' : '~/.agents/skills'}`,
      status: s.error ? 'unsupported' : !remote ? 'new' : remote.hash === s.hash ? 'same' : 'changed',
      ...(s.error ? { reason: s.error } : {}),
    })
  }
  const deviceBlock = new Map((device.rows ?? []).map((r) => [r.id, r]))
  const deviceIds = new Set(device.rowIds ?? [])
  for (const r of local.rows) {
    const remote = deviceBlock.get(r.id)
    const conflict = !remote && deviceIds.has(r.id)
    add({
      key: `row:${r.id}`,
      kind: r.kind,
      label: r.kind === 'mcp' ? String(r.config?.name ?? r.id) : String(r.config?.name ?? r.config?.id ?? r.id),
      detail: r.kind === 'mcp' ? (r.config?.command ? `stdio · ${r.config.command}` : r.config?.url ? `http · ${r.config.url}` : r.id) : r.id,
      status: conflict ? 'conflict' : !remote ? 'new' : remote.hash === r.hash ? 'same' : 'changed',
      ...(conflict ? { reason: 'already-on-device' } : {}),
      warn: rowWarnings(r),
    })
  }
  for (const p of local.plugins) {
    const remote = (device.plugins ?? []).find((x) => x.name === p.name)
    const where = classifySpec(p.source, profileDir)
    let status = !remote ? 'new' : remote.version === p.version ? 'same' : 'changed'
    let reason
    if (p.desktopOnly) {
      status = 'unsupported'
      reason = 'desktop-only'
    } else if (status !== 'same' && where.kind === 'folder') {
      status = 'unsupported'
      reason = 'local-folder'
    } else if (status !== 'same' && (where.kind === 'link' || where.kind === 'missing' || where.kind === 'unknown')) {
      status = 'unsupported'
      reason = 'no-source'
    } else if (status !== 'same' && where.kind === 'tarball' && where.size > MAX_TARBALL_BYTES) {
      status = 'unsupported'
      reason = 'too-large'
    } else if (device.pluginManager === false) {
      status = 'unsupported'
      reason = 'no-plugin-manager'
    }
    add({
      key: `plugin:${p.name}`,
      kind: 'plugin',
      label: p.name,
      detail: [p.version, remote && remote.version !== p.version ? `device ${remote.version ?? '?'}` : null].filter(Boolean).join(' · '),
      status,
      ...(reason ? { reason } : {}),
    })
  }
  return items
}

/** Read the picked items' contents into the bundle the device applies. */
export function buildBundle(local, keys, { profileDir = null } = {}) {
  const pick = new Set(keys)
  const h = homes()
  const bundle = { instructions: [], skills: [], rows: [], plugins: [] }
  for (const i of local.instructions) {
    if (!pick.has(`instructions:${i.target}`)) continue
    const text = readText(i.file)
    if (text !== null) bundle.instructions.push({ target: i.target, content: text })
  }
  for (const s of local.skills) {
    if (!pick.has(`skill:${s.root}:${s.name}`) || s.error) continue
    const skill = readSkill(path.join(h[s.root], 'skills'), s.name)
    if (skill) bundle.skills.push({ root: s.root, name: s.name, flat: skill.flat, files: skill.files.map((f) => ({ path: f.path, data: f.data.toString('base64') })) })
  }
  for (const r of local.rows) {
    if (!pick.has(`row:${r.id}`)) continue
    bundle.rows.push({ id: r.id, name: r.name, ...(r.config !== undefined ? { config: r.config } : {}) })
  }
  for (const p of local.plugins) {
    if (!pick.has(`plugin:${p.name}`) || p.desktopOnly) continue
    const where = classifySpec(p.source, profileDir)
    if (where.kind === 'tarball') bundle.plugins.push({ name: p.name, version: p.version, tarball: fs.readFileSync(where.file).toString('base64'), replace: true })
    else if (where.kind === 'remote') bundle.plugins.push({ name: p.name, version: p.version, spec: where.spec, replace: true })
  }
  return bundle
}
