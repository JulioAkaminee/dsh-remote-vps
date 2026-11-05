// Desktop-side record of paired devices: `$DSH_HOME/devices/devices.json`
// plus one Ed25519 private key per device in `keys/<deviceId>.pem` (0600).

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function writeAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, text, { mode })
  fs.renameSync(tmp, file)
}

export class DeviceRegistry {
  constructor(dir = path.join(dshHome(), 'devices')) {
    this.dir = dir
    this.file = path.join(dir, 'devices.json')
    this.keysDir = path.join(dir, 'keys')
    fs.mkdirSync(this.keysDir, { recursive: true, mode: 0o700 })
    for (const d of [dir, this.keysDir]) {
      try {
        fs.chmodSync(d, 0o700)
      } catch {}
    }
    const doc = this._load()
    this.devices = doc.devices
    /** Desktop-wide preferences the host side needs (e.g. automatic updates). */
    this.preferences = doc.prefs
  }

  _load() {
    try {
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return { devices: Array.isArray(doc.devices) ? doc.devices : [], prefs: doc.prefs && typeof doc.prefs === 'object' ? doc.prefs : {} }
    } catch (error) {
      if (error.code === 'ENOENT') return { devices: [], prefs: {} }
      throw new Error(`dsh-devices: cannot read ${this.file}: ${error.message}`)
    }
  }

  save() {
    writeAtomic(this.file, JSON.stringify({ version: 1, devices: this.devices, prefs: this.preferences }, null, 2) + '\n')
  }

  prefs() {
    return { ...this.preferences }
  }

  setPrefs(patch) {
    this.preferences = { ...this.preferences, ...patch }
    this.save()
    return this.prefs()
  }

  list() {
    return this.devices
  }

  get(id) {
    return this.devices.find((d) => d.id === id)
  }

  /** Insert or replace by device id (re-pairing the same device replaces its record). */
  upsert(record) {
    const i = this.devices.findIndex((d) => d.id === record.id)
    if (i >= 0) this.devices[i] = { ...this.devices[i], ...record }
    else this.devices.push(record)
    this.save()
    return this.get(record.id)
  }

  update(id, patch) {
    const d = this.get(id)
    if (!d) return undefined
    Object.assign(d, patch)
    this.save()
    return d
  }

  remove(id) {
    this.devices = this.devices.filter((d) => d.id !== id)
    this.save()
    fs.rmSync(this.keyFile(id), { force: true })
  }

  keyFile(id) {
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) throw new Error(`invalid device id: ${id}`)
    return path.join(this.keysDir, `${id}.pem`)
  }

  writeKey(id, pem) {
    writeAtomic(this.keyFile(id), pem)
  }

  readKey(id) {
    return fs.readFileSync(this.keyFile(id), 'utf8')
  }
}
