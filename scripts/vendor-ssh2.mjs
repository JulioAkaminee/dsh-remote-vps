#!/usr/bin/env node
// Rebuild lib/vendor/ssh2.mjs from vendor-src/ (needs esbuild).
//
// The plugin host on macOS rewrites CommonJS imports and loses ssh2's exports,
// so ssh2 ships as one plain ES module with static names instead. The sources
// stay in vendor-src/ (outside the package's `files`, so they are not installed).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = path.join(root, 'packages', 'dsh-devices')
const esbuild = process.env.ESBUILD || 'esbuild'

const entry = path.join(pkg, 'vendor-src', 'ssh2-entry.mjs')
const out = path.join(pkg, 'lib', 'vendor', 'ssh2.mjs')
if (!fs.existsSync(entry)) throw new Error(`missing ${entry}`)
if (!fs.existsSync(path.join(pkg, 'vendor-src', 'node_modules', 'ssh2'))) throw new Error('missing vendor-src/node_modules/ssh2')

// CommonJS files inside the bundle still call require()/__dirname: give the ES
// module both, created from its own URL, so node built-ins and the Windows
// agent path keep working.
const banner = [
  "import { createRequire as __dshCreateRequire } from 'node:module';",
  "import { fileURLToPath as __dshFileURL } from 'node:url';",
  "import { dirname as __dshDirname } from 'node:path';",
  'const __filename = __dshFileURL(import.meta.url);',
  'const __dirname = __dshDirname(__filename);',
  'const require = __dshCreateRequire(import.meta.url);',
].join(' ')

execFileSync(
  esbuild,
  [
    entry,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    `--outfile=${out}`,
    '--external:cpu-features',
    '--legal-comments=none',
    `--banner:js=${banner}`,
  ],
  { stdio: 'inherit', cwd: pkg },
)
console.log(`built ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`)
