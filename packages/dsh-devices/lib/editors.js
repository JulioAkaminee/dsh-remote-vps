// Open a device's files in an editor on this computer, over Remote-SSH.
// VS Code and its forks share the URI form:
//   <scheme>://vscode-remote/ssh-remote+<ssh host><absolute path>
// so a folder or file on the VPS opens in the desktop editor, connected to the VPS.

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const EDITORS = Object.freeze([
  { id: 'vscode', label: 'VS Code', scheme: 'vscode', apps: ['Visual Studio Code.app'], cli: 'code' },
  { id: 'cursor', label: 'Cursor', scheme: 'cursor', apps: ['Cursor.app'], cli: 'cursor' },
  { id: 'windsurf', label: 'Windsurf', scheme: 'windsurf', apps: ['Windsurf.app'], cli: 'windsurf' },
  { id: 'vscode-insiders', label: 'VS Code Insiders', scheme: 'vscode-insiders', apps: ['Visual Studio Code - Insiders.app'], cli: 'code-insiders' },
])

function onPath(cli) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cli], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let cache = null
/** Editors with an `installed` flag (macOS: /Applications; elsewhere: CLI on PATH). Cached 60 s. */
export function detectEditors() {
  if (cache && Date.now() - cache.at < 60_000) return cache.list
  const list = EDITORS.map((e) => {
    let installed = false
    if (process.platform === 'darwin') {
      installed = e.apps.some((app) => fs.existsSync(path.join('/Applications', app)) || fs.existsSync(path.join(os.homedir(), 'Applications', app)))
    }
    if (!installed) installed = onPath(e.cli)
    return { id: e.id, label: e.label, installed }
  })
  cache = { at: Date.now(), list }
  return list
}

/** The editor to use: the requested one, else the first installed, else VS Code. */
export function pickEditor(requested) {
  const list = detectEditors()
  const byId = (id) => EDITORS.find((e) => e.id === id)
  if (requested && byId(requested)) return byId(requested)
  const first = list.find((e) => e.installed)
  return byId(first ? first.id : 'vscode')
}

/** Remote-SSH URI for an absolute path on the device. */
export function editorUri(editor, sshHost, absolutePath) {
  const host = String(sshHost ?? '').trim()
  if (!host || /[\s/]/.test(host)) throw new Error('this device has no SSH host for editors')
  const p = String(absolutePath ?? '').trim()
  if (!p.startsWith('/')) throw new Error('need an absolute path on the device')
  const encodedPath = p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  return `${editor.scheme}://vscode-remote/ssh-remote+${host}${encodedPath}`
}

/** Hand a URL to the operating system (DSH_DEVICES_OPEN_CMD overrides, e.g. for tests). */
export function openUrl(url) {
  const custom = process.env.DSH_DEVICES_OPEN_CMD
  const [cmd, args] = custom
    ? [custom, [url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000 }, (error) => (error ? reject(new Error(`could not open the editor: ${error.message}`)) : resolve()))
  })
}
