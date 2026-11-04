#!/usr/bin/env node
// Create (or refresh) a dsh profile that links local plugin packages.
//
//   node scripts/make-profile.mjs --home <DSH_HOME> --profile <name> \
//        --link <pkgdir>[,<pkgdir>...] [--bundles a,b,c]
//
// The profile's bundles default to the web surface plus every linked package.

import fs from 'node:fs'
import path from 'node:path'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const home = path.resolve(arg('home', process.env.DSH_HOME ?? path.join(process.env.HOME, '.dsh')))
const profile = arg('profile')
if (!profile) throw new Error('--profile is required')
const links = (arg('link', '') || '').split(',').filter(Boolean).map((p) => path.resolve(p))
const dir = path.join(home, 'profiles', profile)
fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })

const pkgFile = path.join(dir, 'package.json')
const doc = fs.existsSync(pkgFile)
  ? JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  : { name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
doc.dependencies ??= {}
doc.dsh ??= {}
doc.dsh.profile ??= {}

const names = []
for (const link of links) {
  const { name } = JSON.parse(fs.readFileSync(path.join(link, 'package.json'), 'utf8'))
  names.push(name)
  doc.dependencies[name] = `link:${link}`
  const target = path.join(dir, 'node_modules', name)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.symlinkSync(link, target, 'dir')
}

const bundles = arg('bundles')
doc.dsh.profile.bundles = bundles
  ? bundles.split(',').filter(Boolean)
  : [...new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...names])]

fs.writeFileSync(pkgFile, JSON.stringify(doc, null, 2) + '\n')
for (const [file, body] of [
  ['cordis.yml', '# dsh profile root; composed from bundles then cordis.patch.yml\n[]\n'],
  ['cordis.patch.yml', '# your patch layer for this profile\n[]\n'],
  ['pnpm-workspace.yaml', 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'],
]) {
  const f = path.join(dir, file)
  if (!fs.existsSync(f)) fs.writeFileSync(f, body)
}
console.log(`profile ${profile} at ${dir}: bundles ${doc.dsh.profile.bundles.join(', ')}`)
