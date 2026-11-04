// Helper for tests: log into a local dsh web instance (launch-token exchange)
// and call its authenticated /api routes as the owner browser would.
import fs from 'node:fs'
import http from 'node:http'

export function launchUrlFromLog(logFile) {
  const text = fs.readFileSync(logFile, 'utf8')
  const m = [...text.matchAll(/dsh web: (http:\/\/\S+\?token=\S+)/g)].pop()
  if (!m) throw new Error(`no launch URL in ${logFile}`)
  return m[1]
}

export async function login(launchUrl) {
  const url = new URL(launchUrl)
  const cookie = await new Promise((resolve, reject) => {
    http
      .get(url, { headers: { accept: 'text/html' } }, (res) => {
        res.resume()
        const set = res.headers['set-cookie'] ?? []
        resolve(set.map((c) => c.split(';')[0]).join('; '))
      })
      .on('error', reject)
  })
  if (!cookie) throw new Error('login failed: no cookie')
  const origin = url.origin
  const call = (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      const req = http.request(
        new URL(path, origin),
        {
          method,
          headers: {
            cookie,
            origin,
            accept: 'application/json',
            ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          },
        },
        (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => {
            let json = text
            try {
              json = JSON.parse(text)
            } catch {}
            resolve({ status: res.statusCode, body: json })
          })
        },
      )
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  return { origin, cookie, call }
}
