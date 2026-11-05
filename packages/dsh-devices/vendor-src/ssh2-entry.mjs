// Entry for the vendored ssh2 build: the app's host rewrites CommonJS imports
// in ways that lose the exports, so ssh2 is bundled here into one plain ES
// module with the two names the transport needs. Regenerate with
// `node scripts/vendor-ssh2.mjs` (needs esbuild).
import ssh2 from 'ssh2'

export const Client = ssh2.Client
export const utils = ssh2.utils
export default ssh2
