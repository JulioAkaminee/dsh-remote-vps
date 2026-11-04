// Small HTTP helpers shared by the host routes.

export function sendJson(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  res.end(body)
}

export function sendError(res, status, error, detail) {
  sendJson(res, status, detail === undefined ? { error } : { error, detail })
}

/** Read a JSON request body up to `limit` bytes. */
export function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Remote address as seen by this listener (behind SSH this is loopback). */
export function remoteAddress(req) {
  return req.socket?.remoteAddress ?? 'unknown'
}
