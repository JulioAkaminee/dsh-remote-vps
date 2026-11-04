#!/bin/sh
# Install (or remove) the dsh-devices plugin in your desktop DeepSeek Harness.
#
#   sh install-desktop.sh ./dsh-devices-X.Y.Z.tgz [--profile NAME]
#   sh install-desktop.sh --uninstall [--profile NAME]
#
# The package is unpacked to ~/.dsh-devices/dsh-devices and linked into the
# profile (dependency + bundle + node_modules symlink), the same way the
# desktop app wires its own plugins. Restart DeepSeek Harness afterwards.
set -eu

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
ROOT="${DSH_DEVICES_ROOT:-$HOME/.dsh-devices}"
TARBALL=""
PROFILE=""
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) TARBALL="$1"; shift ;;
  esac
done

NODE=""
for c in "$HOME/.dsh-desktop/runtime/bin/node" "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
[ -n "$NODE" ] || { echo "error: node not found (install DeepSeek Harness desktop first)"; exit 1; }

# Pick the profile the desktop app boots: explicit, else the one carrying the
# desktop app's own dsh-tauri plugins, else "desktop", else "web".
echo "profiles found: $(ls "$DSH_HOME/profiles" 2>/dev/null | tr '\n' ' ')"
if [ -z "$PROFILE" ]; then
  PROFILE=$(DSH_HOME="$DSH_HOME" "$NODE" -e '
const fs = require("fs"), path = require("path")
const dir = path.join(process.env.DSH_HOME, "profiles")
let names = []
try { names = fs.readdirSync(dir) } catch {}
const bundlesOf = (name) => {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, name, "package.json"), "utf8"))
    return (doc.dsh && doc.dsh.profile && doc.dsh.profile.bundles) || []
  } catch { return null }
}
const tauri = names.find((n) => n !== "remote" && n !== "device-host" && (bundlesOf(n) || []).some((b) => /^dsh-tauri/.test(b)))
console.log(tauri || (bundlesOf("desktop") ? "desktop" : "web"))')
fi
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
echo "profile: $PROFILE ($PROFILE_DIR)"

if [ "$UNINSTALL" = 0 ]; then
  [ -n "$TARBALL" ] && [ -f "$TARBALL" ] || { echo "usage: sh install-desktop.sh ./dsh-devices-X.Y.Z.tgz [--profile NAME]"; exit 1; }
  mkdir -p "$ROOT"
  rm -rf "$ROOT/dsh-devices.new" && mkdir -p "$ROOT/dsh-devices.new"
  tar -xzf "$TARBALL" -C "$ROOT/dsh-devices.new" --strip-components=1
  rm -rf "$ROOT/dsh-devices" && mv "$ROOT/dsh-devices.new" "$ROOT/dsh-devices"
  mkdir -p "$PROFILE_DIR/node_modules"
fi

DSH_DEVICES_PROFILE="$PROFILE_DIR" DSH_DEVICES_PKG="$ROOT/dsh-devices" DSH_DEVICES_UNINSTALL="$UNINSTALL" "$NODE" -e '
const fs = require("fs"), path = require("path")
const dir = process.env.DSH_DEVICES_PROFILE, pkg = process.env.DSH_DEVICES_PKG, remove = process.env.DSH_DEVICES_UNINSTALL === "1"
const file = path.join(dir, "package.json")
const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { name: "dsh-profile-" + path.basename(dir), private: true }
doc.dependencies = doc.dependencies || {}
doc.dsh = doc.dsh || {}; doc.dsh.profile = doc.dsh.profile || {}
let bundles = Array.isArray(doc.dsh.profile.bundles) ? doc.dsh.profile.bundles : []
if (!fs.existsSync(file) && !remove) bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
const link = path.join(dir, "node_modules", "dsh-devices")
if (remove) {
  delete doc.dependencies["dsh-devices"]
  bundles = bundles.filter((b) => b !== "dsh-devices")
  fs.rmSync(link, { recursive: true, force: true })
} else {
  doc.dependencies["dsh-devices"] = "link:" + pkg
  if (!bundles.includes("dsh-devices")) bundles.push("dsh-devices")
  fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(pkg, link, "dir")
}
doc.dsh.profile.bundles = bundles
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n")
for (const [f, body] of [["cordis.yml", "[]\n"], ["cordis.patch.yml", "[]\n"]]) if (!fs.existsSync(path.join(dir, f))) fs.writeFileSync(path.join(dir, f), body)
'

if [ "$UNINSTALL" = 1 ]; then
  rm -rf "$ROOT/dsh-devices"
  echo "dsh-devices removed from profile $PROFILE. Paired-device records stay in $DSH_HOME/devices."
else
  echo "dsh-devices $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/dsh-devices/package.json" | head -1) installed into profile $PROFILE."
fi
echo "Restart DeepSeek Harness to apply."
