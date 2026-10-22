'use strict'
/**
 * pino-lens example — a small HTTP service that logs through the pino build
 * from this repository (../../pino.js), not an npm copy.
 *
 * The point is to exercise the parts of the real wire format that a viewer has
 * to cope with: numeric levels plus one custom level, `responseTime` latencies,
 * serialised Error objects, child-logger bindings, redaction markers, unicode
 * messages, nested objects and arrays.
 *
 * MIT License. See lens/LICENSE.
 */

const http = require('node:http')
const { STATUS_CODES } = require('node:http')

// The repository build. `require('../../../pino.js')` resolves to v10.4.0 in-place.
const pino = require('../../../pino.js')

const ITEMS = Array.from({ length: 250 }, (_, i) => ({
  id: 'itm_' + String(i + 1).padStart(4, '0'),
  name: ['widget', 'gasket', 'flange', 'bracket', 'sprocket'][i % 5] + ' ' + (i + 1),
  price: Number((5 + (i % 97) * 1.37).toFixed(2)),
  tags: ['hardware', i % 3 === 0 ? 'new' : 'stock']
}))

function createService (options) {
  const opts = options || {}
  const destination = opts.destination
  const loggerOptions = {
    // A stable, non-identifying hostname keeps machine names out of the sample
    // data while remaining a genuine pino `base` configuration.
    base: { pid: process.pid, hostname: opts.hostname || 'lab-node-01' },
    level: opts.level || 'debug',
    customLevels: { notice: 35 },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'password'],
      censor: '[Redacted]'
    },
    timestamp: pino.stdTimeFunctions.epochTime
  }
  const log = destination ? pino(loggerOptions, destination) : pino(loggerOptions)
  let seq = 0

  const server = http.createServer((req, res) => {
    const started = process.hrtime.bigint()
    const reqId = 'req_' + String(++seq).padStart(6, '0')
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'))
    const child = log.child({ reqId, route: url.pathname })

    if (url.pathname !== '/healthz') {
      child.debug({ req: { method: req.method, url: req.url, headers: { authorization: req.headers.authorization || null, 'user-agent': req.headers['user-agent'] || null } } }, 'request received')
    }

    const finish = (status, payload, note) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      const line = {
        status,
        responseTime: Number(ms.toFixed(2)),
        bytes: Buffer.byteLength(payload || ''),
        method: req.method
      }
      if (note) line.note = note
      if (status >= 500) child.error(line, 'request failed: %s', STATUS_CODES[status] || 'error')
      else if (status >= 400) child.warn(line, 'request rejected: %s', STATUS_CODES[status] || 'bad request')
      else if (ms > 120) child.warn({ ...line, slow: true }, 'slow request')
      else if (url.pathname === '/healthz') child.trace(line, 'health probe')
      else child.info(line, 'request completed')
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-request-id': reqId })
      res.end(payload || '')
    }

    try {
      if (url.pathname === '/healthz') return finish(200, '{"ok":true}')

      if (url.pathname === '/api/items' && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 10), 50)
        return finish(200, JSON.stringify({ items: ITEMS.slice(0, limit) }))
      }

      if (url.pathname.startsWith('/api/items/') && req.method === 'GET') {
        const id = url.pathname.split('/')[3]
        const item = ITEMS.find(i => i.id === id)
        if (!item) return finish(404, JSON.stringify({ error: 'item not found', id }))
        return finish(200, JSON.stringify(item))
      }

      if (url.pathname === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim()
        if (!q) return finish(400, JSON.stringify({ error: 'q is required' }))
        const hits = ITEMS.filter(i => i.name.includes(q) || i.tags.includes(q))
        child.notice({ q, hits: hits.length }, 'search executed for "%s"', q)
        if (hits.length === 0) {
          return finish(200, JSON.stringify({ q, hits: 0, items: [] }), 'empty result set')
        }
        return finish(200, JSON.stringify({ q, hits: hits.length, items: hits.slice(0, 5) }))
      }

      if (url.pathname === '/api/slow') {
        const delay = Math.min(Number(url.searchParams.get('ms') || 180), 900)
        const jitter = Math.floor(Math.random() * 40)
        setTimeout(() => finish(200, JSON.stringify({ delayed: delay, jitter })), delay)
        return
      }

      if (url.pathname === '/api/boom') {
        const kind = url.searchParams.get('kind') || 'type'
        if (kind === 'type') throw new TypeError('cannot read properties of undefined (reading "sku")')
        if (kind === 'nested') {
          try {
            JSON.parse('{"broken":')
          } catch (cause) {
            const err = new Error('upstream payload was not valid JSON', { cause })
            err.code = 'EUPSTREAMJSON'
            throw err
          }
        }
        throw new Error('database connection reset while loading item batch')
      }

      if (url.pathname === '/api/echo' && req.method === 'POST') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          try {
            const parsed = body ? JSON.parse(body) : {}
            child.info({ payload: parsed, authSeen: Boolean(req.headers.authorization) }, 'echo body accepted')
            finish(200, JSON.stringify({ ok: true, received: Object.keys(parsed).length }))
          } catch (err) {
            finish(400, JSON.stringify({ error: 'malformed json body' }))
          }
        })
        return
      }

      if (url.pathname === '/api/greet') {
        const name = url.searchParams.get('name') || 'world'
        child.info({ name, tags: ['greeting', 'unicode'] }, 'greeting rendered: 你好，%s 👋', name)
        return finish(200, JSON.stringify({ greeting: '你好，' + name }))
      }

      return finish(404, JSON.stringify({ error: 'no such route', path: url.pathname }))
    } catch (err) {
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      child.error({ responseTime: Number(ms.toFixed(2)), err }, 'handler threw')
      finish(500, JSON.stringify({ error: 'internal error', reqId }))
    }
  })

  return { server, log, loggerOptions }
}

module.exports = { createService, ITEMS }
