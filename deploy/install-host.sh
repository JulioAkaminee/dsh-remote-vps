#!/bin/sh
# Install or update the DSH device host on this machine.
#
#   sh install-host.sh --plugin ./dsh-device-host-X.Y.Z.tgz [--dsh-version V] [--port 3180]
#                      [--name "My VPS"] [--no-service]
#
# Layout:  ~/.dsh-device/{node,runtime,bin,env}   and   $DSH_HOME/profiles/device-host
# Result:  the last stdout line is `DSH_DEVICE_INSTALL_RESULT {json}` (read by dsh-devices).
set -eu

ROOT="${DSH_DEVICE_ROOT:-$HOME/.dsh-device}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
NODE_VERSION="${DSH_DEVICE_NODE_VERSION:-22.22.0}"
PLUGIN=""
DSH_VERSION="latest"
PORT="3180"
NAME=""
SERVICE=1

result_fail() {
  msg=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
  echo "DSH_DEVICE_INSTALL_RESULT {\"ok\":false,\"error\":\"$msg\"}"
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --plugin) PLUGIN="$2"; shift 2 ;;
    --dsh-version) DSH_VERSION="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    *) result_fail "unknown argument: $1" ;;
  esac
done
[ -n "$PLUGIN" ] && [ -f "$PLUGIN" ] || result_fail "--plugin <dsh-device-host tarball> is required"
# Absolute path: npm reads a bare "dir/file.tgz" as a GitHub "owner/repo" spec.
PLUGIN="$(cd "$(dirname "$PLUGIN")" && pwd)/$(basename "$PLUGIN")"

mkdir -p "$ROOT/bin" "$ROOT/runtime"
chmod 700 "$ROOT"

# ── node >= 22.19 ────────────────────────────────────────────────────────────
node_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null
}
NODE=""
for candidate in "$ROOT/node/bin/node" "$(command -v node 2>/dev/null || true)" "$HOME/.dsh-desktop/runtime/bin/node"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && node_ok "$candidate"; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) result_fail "unsupported OS $(uname -s)" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) result_fail "unsupported CPU $(uname -m)" ;; esac
  url="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$os-$arch.tar.gz"
  echo "downloading Node.js $NODE_VERSION ($os-$arch)"
  tmp="$ROOT/node-download.tar.gz"
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" -o "$tmp" || result_fail "download failed: $url"
  elif command -v wget >/dev/null 2>&1; then wget -q "$url" -O "$tmp" || result_fail "download failed: $url"
  else result_fail "need curl or wget to download Node.js"; fi
  rm -rf "$ROOT/node" && mkdir -p "$ROOT/node"
  tar -xzf "$tmp" -C "$ROOT/node" --strip-components=1 || result_fail "could not extract Node.js"
  rm -f "$tmp"
  NODE="$ROOT/node/bin/node"
fi
NODE_BIN_DIR=$(dirname "$NODE")
PATH="$NODE_BIN_DIR:$PATH"; export PATH
NPM="$NODE_BIN_DIR/npm"
[ -x "$NPM" ] || NPM="$(command -v npm 2>/dev/null || true)"
[ -n "$NPM" ] || result_fail "npm not found next to $NODE"
echo "using node $("$NODE" --version) at $NODE"

# ── dsh + plugin ─────────────────────────────────────────────────────────────
[ -f "$ROOT/runtime/package.json" ] || printf '{\n  "name": "dsh-device-runtime",\n  "private": true\n}\n' > "$ROOT/runtime/package.json"
echo "installing @deepseek-ai/dsh@$DSH_VERSION and $(basename "$PLUGIN")"
"$NPM" install --prefix "$ROOT/runtime" --no-audit --no-fund --omit=dev --loglevel=error \
  "@deepseek-ai/dsh@$DSH_VERSION" "$PLUGIN" || result_fail "npm install failed"
DSH_BIN="$ROOT/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"
CLI="$ROOT/runtime/node_modules/dsh-device-host/bin/dsh-device.mjs"
[ -f "$DSH_BIN" ] || result_fail "dsh was not installed"
[ -f "$CLI" ] || result_fail "dsh-device-host was not installed"

cat > "$ROOT/bin/dsh-device" <<EOF
#!/bin/sh
DSH_HOME="\${DSH_HOME:-$DSH_HOME}" exec "$NODE" "$CLI" "\$@"
EOF
cat > "$ROOT/bin/dsh" <<EOF
#!/bin/sh
DSH_HOME="\${DSH_HOME:-$DSH_HOME}" exec "$NODE" "$DSH_BIN" "\$@"
EOF
chmod 755 "$ROOT/bin/dsh-device" "$ROOT/bin/dsh"
[ -f "$ROOT/env" ] || { printf '# Extra environment for the device host, e.g.\n# DEEPSEEK_API_KEY=sk-...\n' > "$ROOT/env"; chmod 600 "$ROOT/env"; }
if [ -d "$HOME/.local/bin" ] && [ ! -e "$HOME/.local/bin/dsh-device" ]; then ln -s "$ROOT/bin/dsh-device" "$HOME/.local/bin/dsh-device" 2>/dev/null || true; fi

# ── device-host profile ──────────────────────────────────────────────────────
PROFILE="$DSH_HOME/profiles/device-host"
mkdir -p "$PROFILE/node_modules"
DSH_DEVICE_PROFILE="$PROFILE" DSH_DEVICE_PLUGIN_DIR="$ROOT/runtime/node_modules/dsh-device-host" "$NODE" -e '
const fs = require("fs"), path = require("path")
const dir = process.env.DSH_DEVICE_PROFILE, plugin = process.env.DSH_DEVICE_PLUGIN_DIR
const file = path.join(dir, "package.json")
const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { name: "dsh-profile-device-host", private: true }
doc.dependencies = { ...(doc.dependencies || {}), "dsh-device-host": "link:" + plugin }
doc.dsh = doc.dsh || {}; doc.dsh.profile = doc.dsh.profile || {}
const bundles = Array.isArray(doc.dsh.profile.bundles) ? doc.dsh.profile.bundles : []
for (const b of ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-device-host"]) if (!bundles.includes(b)) bundles.push(b)
doc.dsh.profile.bundles = bundles
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n")
const link = path.join(dir, "node_modules", "dsh-device-host")
fs.rmSync(link, { recursive: true, force: true })
fs.symlinkSync(plugin, link, "dir")
const files = {
  "cordis.yml": "# dsh profile root; composed from bundles then cordis.patch.yml\n[]\n",
  "cordis.patch.yml": "# your patch layer for the device-host profile\n[]\n",
  "pnpm-workspace.yaml": "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
}
for (const [f, body] of Object.entries(files)) if (!fs.existsSync(path.join(dir, f))) fs.writeFileSync(path.join(dir, f), body)
' || result_fail "could not write the device-host profile"
if [ -n "$NAME" ]; then "$ROOT/bin/dsh-device" name "$NAME" >/dev/null; fi

# ── port: keep the running host's port, otherwise the first free one ─────────
# (a self-update passes the port it runs on with DSH_DEVICE_FORCE_PORT=1: kept as is)
current=""
if [ "${DSH_DEVICE_FORCE_PORT:-0}" != 1 ]; then
  current=$("$ROOT/bin/dsh-device" status --json 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j.running&&j.origin)console.log(new URL(j.origin).port)}catch{}})' || true)
fi
if [ "${DSH_DEVICE_FORCE_PORT:-0}" = 1 ]; then :; elif [ -n "$current" ]; then PORT="$current"; else
  PORT=$("$NODE" -e '
const net = require("net"); let p = Number(process.argv[1])
const tryPort = () => { const s = net.createServer(); s.once("error", () => { p++; tryPort() }); s.listen(p, "127.0.0.1", () => s.close(() => console.log(p))) }
tryPort()' "$PORT")
fi

# ── service ──────────────────────────────────────────────────────────────────
mode="none"
if [ "$SERVICE" = 1 ]; then
  if systemctl --user show-environment >/dev/null 2>&1; then
    "$ROOT/bin/dsh-device" service install --port "$PORT" --node "$NODE" --dsh-bin "$DSH_BIN" || result_fail "systemd service install failed"
    systemctl --user restart dsh-device-host || result_fail "could not restart dsh-device-host"
    mode="systemd"
  else
    echo "systemd --user unavailable: starting in the background (no restart on reboot)"
    if [ -f "$ROOT/host.pid" ] && kill -0 "$(cat "$ROOT/host.pid")" 2>/dev/null; then
      old_pid=$(cat "$ROOT/host.pid"); kill "$old_pid" || true
      # The old host must be gone before the new one binds its port (and before /hello is checked).
      n=0; while kill -0 "$old_pid" 2>/dev/null && [ "$n" -lt 15 ]; do sleep 1; n=$((n + 1)); done
      kill -9 "$old_pid" 2>/dev/null || true
    fi
    # shellcheck disable=SC1091
    ( set -a; [ -f "$ROOT/env" ] && . "$ROOT/env"; set +a
      DSH_HOME="$DSH_HOME" nohup "$NODE" "$DSH_BIN" --profile device-host --no-open --host 127.0.0.1 --port "$PORT" >> "$ROOT/host.log" 2>&1 &
      echo $! > "$ROOT/host.pid" )
    mode="background"
  fi
  echo "waiting for the device host on 127.0.0.1:$PORT"
  i=0
  until "$NODE" -e '
require("http").get("http://127.0.0.1:" + process.argv[1] + "/device/v1/hello", r => process.exit(r.statusCode === 200 ? 0 : 1)).on("error", () => process.exit(1))' "$PORT"; do
    i=$((i + 1)); [ "$i" -lt 90 ] || result_fail "the device host did not answer on port $PORT (see: dsh-device service logs)"
    sleep 1
  done
fi

status=$("$ROOT/bin/dsh-device" status --json 2>/dev/null || echo '{}')
echo "DSH_DEVICE_INSTALL_RESULT $("$NODE" -e '
const s = JSON.parse(process.argv[1] || "{}")
console.log(JSON.stringify({ ok: true, port: Number(process.argv[2]), service: process.argv[3], deviceId: s.deviceId, name: s.name, versions: s.versions, running: s.running }))' "$status" "$PORT" "$mode")"
