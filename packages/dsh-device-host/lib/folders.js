// Folders and workspaces on the device, so a desktop can organise remote chats
// the way DSH does: one workspace per project folder, each a group in the sidebar.
//
// DSH's own rule: a session belongs to the workspace whose path IS its working
// directory (workspace.sessionIds holds that membership). A workspace for a
// parent folder does not collect the chats of its subfolders.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Files that make a folder look like a project (shown as a hint, never required). */
export const PROJECT_MARKERS = Object.freeze([
  '.git',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'deno.json',
  'mix.exs',
  'pubspec.yaml',
  'CMakeLists.txt',
  'Makefile',
  'docker-compose.yml',
  'compose.yaml',
  'AGENTS.md',
])
export const MAX_FOLDER_ENTRIES = 500
/** One path segment: no separators, not "." / "..", no control characters. */
export const SAFE_FOLDER_NAME = /^(?!\.{1,2}$)[^/\\\0\x01-\x1f]{1,255}$/

/**
 * The workspace a session row belongs to: its membership when the registry
 * exposes it, else the workspace whose path equals the session's directory.
 */
export function owningWorkspace(row, workspaces) {
  const list = Array.isArray(workspaces) ? workspaces : []
  const byMembership = list.find((w) => {
    try {
      const ids = w.sessionIds
      return !!ids && typeof ids.includes === 'function' && ids.includes(row.sessionId)
    } catch {
      return false
    }
  })
  if (byMembership) return byMembership
  if (!row.cwd) return null
  const cwd = path.resolve(row.cwd)
  return list.find((w) => w.path && path.resolve(w.path) === cwd) ?? null
}

/** The nearest workspace folder that contains `p` (its parent in DSH's "workspace tree"). */
export function parentWorkspacePath(p, paths) {
  let best = null
  for (const candidate of paths) {
    if (!candidate || candidate === p) continue
    const prefix = candidate.endsWith(path.sep) ? candidate : candidate + path.sep
    if (p.startsWith(prefix) && (!best || candidate.length > best.length)) best = candidate
  }
  return best
}

function projectMarkers(dir) {
  const found = []
  for (const marker of PROJECT_MARKERS) {
    try {
      fs.accessSync(path.join(dir, marker))
      found.push(marker)
    } catch {}
    if (found.length >= 3) break
  }
  return found
}

/**
 * One level of folders under `dir` (default: the home folder), for the desktop's
 * folder browser: each with its project hints and whether it is already a workspace.
 */
export function listFolders(dir, { workspaces = [], showHidden = false, home = os.homedir() } = {}) {
  const target = path.resolve(typeof dir === 'string' && dir.trim() ? dir : home)
  let entries
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
  } catch (error) {
    const code = error && error.code
    throw Object.assign(new Error(code === 'ENOENT' ? 'folder-not-found' : code === 'ENOTDIR' ? 'not-a-folder' : 'folder-unreadable'), { status: code === 'ENOENT' ? 404 : 400 })
  }
  const byPath = new Map(workspaces.filter((w) => w && w.path).map((w) => [path.resolve(w.path), w]))
  // Every folder name first (cheap), sorted, then the hints for the ones shown.
  const names = []
  for (const entry of entries) {
    if (!showHidden && entry.name.startsWith('.')) continue
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(target, entry.name)).isDirectory()
      } catch {}
    }
    if (isDir) names.push(entry.name)
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
  const truncated = names.length > MAX_FOLDER_ENTRIES
  const folders = names.slice(0, MAX_FOLDER_ENTRIES).map((name) => {
    const full = path.join(target, name)
    const ws = byPath.get(full)
    return { name, path: full, project: projectMarkers(full), workspaceId: ws ? ws.id : null }
  })
  const parent = path.dirname(target)
  const current = byPath.get(target)
  return {
    path: target,
    parent: parent === target ? null : parent,
    home,
    project: projectMarkers(target),
    workspaceId: current ? current.id : null,
    folders,
    truncated,
  }
}

/** Create `name` inside `parent` (both checked); returns the new folder's path. */
export function makeFolder(parent, name) {
  const base = path.resolve(String(parent || ''))
  const clean = String(name ?? '').trim()
  if (!SAFE_FOLDER_NAME.test(clean)) throw Object.assign(new Error('invalid-folder-name'), { status: 400 })
  let stat
  try {
    stat = fs.statSync(base)
  } catch {
    throw Object.assign(new Error('folder-not-found'), { status: 404 })
  }
  if (!stat.isDirectory()) throw Object.assign(new Error('not-a-folder'), { status: 400 })
  const full = path.join(base, clean)
  try {
    fs.mkdirSync(full)
  } catch (error) {
    if (error && error.code === 'EEXIST') throw Object.assign(new Error('folder-exists'), { status: 409 })
    throw Object.assign(new Error('folder-create-failed'), { status: 500 })
  }
  return full
}

const view = (w) => ({ id: w.id, path: w.path, title: w.title })

/**
 * Add, rename or remove a workspace through DSH's own registry. Removing keeps
 * the folder and its chats (they show as Ungrouped until a workspace has them again).
 */
export async function workspaceAction(registry, body) {
  if (!registry) throw Object.assign(new Error('workspaces-unavailable'), { status: 501 })
  const action = body && body.action
  if (action === 'create') {
    const paths = Array.isArray(body.paths) ? body.paths : [body.path]
    if (paths.length === 0 || paths.length > 50) throw Object.assign(new Error('invalid-path'), { status: 400 })
    const results = []
    for (const p of paths) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) throw Object.assign(new Error('invalid-path'), { status: 400 })
      const full = path.resolve(p)
      try {
        if (!fs.statSync(full).isDirectory()) throw new Error('not a folder')
      } catch {
        results.push({ path: full, error: 'not-a-folder' })
        continue
      }
      try {
        const existing = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(full) : undefined
        if (existing) results.push({ path: full, workspace: view(existing), created: false })
        else results.push({ path: full, workspace: view(await registry.create(full)), created: true })
      } catch (error) {
        results.push({ path: full, error: String((error && error.message) || error) })
      }
    }
    return { results }
  }
  const list = typeof registry.list === 'function' ? registry.list() : []
  const workspace = list.find((w) => w.id === body.workspaceId)
  if (!workspace) throw Object.assign(new Error('workspace-not-found'), { status: 404 })
  if (action === 'rename') {
    const title = String(body.title ?? '').trim()
    if (!title || title.length > 200) throw Object.assign(new Error('invalid-title'), { status: 400 })
    if (list.some((w) => w.id !== workspace.id && w.title === title)) throw Object.assign(new Error('name-conflict'), { status: 409 })
    if (title !== workspace.title) await workspace.setTitle(title)
    return { workspace: view(workspace) }
  }
  if (action === 'remove') {
    const removed = await registry.delete(workspace.id)
    if (!removed) throw Object.assign(new Error('workspace-not-found'), { status: 404 })
    return { removed: true }
  }
  throw Object.assign(new Error('invalid-action'), { status: 400 })
}
