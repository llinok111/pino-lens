'use strict'
/**
 * pino-lens example — request driver.
 *
 * Uses a seeded PRNG so a run is reproducible: same seed, same request mix,
 * same order. Timings still differ (they are measured, not simulated).
 *
 * MIT License. See lens/LICENSE.
 */

const http = require('node:http')

function mulberry32 (seed) {
  let a = seed >>> 0
  return function random () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CITIES = ['成都', '杭州', '深圳', '乌鲁木齐', 'São Paulo', 'Zürich']

function pick (rand, list) {
  return list[Math.floor(rand() * list.length) % list.length]
}

/**
 * @param {{port: number, requests: number, concurrency?: number, seed?: number,
 *          onProgress?: (done: number, total: number) => void}} options
 */
async function drive (options) {
  const { port, requests } = options
  const concurrency = Math.max(1, options.concurrency || 1)
  const rand = mulberry32(options.seed || 20261023)
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency })
  const stats = { ok: 0, client4xx: 0, server5xx: 0, networkError: 0, total: 0 }

  function fire (n) {
    // Deterministic mix: ~62% reads, 12% search, 8% slow, 6% errors, 6% echo,
    // 4% unicode greet, 2% health probes, remainder 404s.
    const roll = rand()
    let method = 'GET'
    let path
    let body = null
    if (roll < 0.62) {
      path = rand() < 0.45 ? '/api/items?limit=' + (1 + Math.floor(rand() * 30)) : '/api/items/itm_' + String(1 + Math.floor(rand() * 300)).padStart(4, '0')
    } else if (roll < 0.74) {
      path = '/api/search?q=' + encodeURIComponent(pick(rand, ['widget', 'gasket', 'flange', 'nope', 'hardware']))
    } else if (roll < 0.82) {
      path = '/api/slow?ms=' + (120 + Math.floor(rand() * 380))
    } else if (roll < 0.88) {
      path = '/api/boom?kind=' + pick(rand, ['type', 'nested', 'db'])
    } else if (roll < 0.94) {
      method = 'POST'
      path = '/api/echo'
      body = JSON.stringify({ n, city: pick(rand, CITIES), nested: { attempt: n, ok: rand() > 0.2 }, tags: ['load', 'sample'] })
      if (n % 97 === 0) body = '{"broken":'
    } else if (roll < 0.98) {
      path = '/api/greet?name=' + encodeURIComponent(pick(rand, CITIES))
    } else if (roll < 0.99) {
      path = '/healthz'
    } else {
      path = '/api/unknown/' + n
    }

    return new Promise((resolve) => {
      const req = http.request({ port, path, method, agent, headers: { authorization: 'Bearer demo-token-not-a-secret', 'content-type': 'application/json' } }, (res) => {
        res.resume()
        res.on('end', () => {
          if (res.statusCode >= 500) stats.server5xx++
          else if (res.statusCode >= 400) stats.client4xx++
          else stats.ok++
          stats.total++
          resolve()
        })
      })
      req.on('error', () => { stats.networkError++; stats.total++; resolve() })
      if (body) req.write(body)
      req.end()
    })
  }

  let next = 0
  let done = 0
  async function worker () {
    while (true) {
      const n = next++
      if (n >= requests) return
      await fire(n)
      done++
      if (options.onProgress && done % 1000 === 0) options.onProgress(done, requests)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  agent.destroy()
  return stats
}

module.exports = { drive, mulberry32 }
