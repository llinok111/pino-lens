'use strict'
/**
 * pino-lens — statistics over a filtered index set.
 * MIT License. See lens/LICENSE.
 */

;(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./store'))
  } else {
    root.PinoLens = root.PinoLens || {}
    Object.assign(root.PinoLens, factory(root.PinoLens))
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (storeMod) {
  const { FLAG } = storeMod

  const DEFAULT_BUCKETS = 120
  const TOP_MESSAGES = 10

  /** Round a bucket width up to a human-friendly 1/2/5 × 10^k step. */
  function niceStep (rough) {
    if (!Number.isFinite(rough) || rough <= 0) return 1
    const exp = Math.floor(Math.log10(rough))
    const base = Math.pow(10, exp)
    const norm = rough / base
    const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
    return mult * base
  }

  /**
   * Collapse variable parts of a message so repeated log statements group
   * together. This is a *display* heuristic, not a log parser.
   */
  function templateOf (msg) {
    let text = String(msg || '')
    text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    text = text.replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    text = text.replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<ts>')
    text = text.replace(/\b\d+(\.\d+)?\b/g, '#')
    text = text.replace(/\s+/g, ' ').trim()
    if (text.length > 120) text = text.slice(0, 117) + '…'
    return text
  }

  function percentile (sorted, p) {
    if (sorted.length === 0) return null
    const rank = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]
  }

  /**
   * @param {object} store
   * @param {Int32Array|number[]} indices
   * @param {{buckets?: number}} [options]
   */
  function summarize (store, indices, options) {
    const opts = options || {}
    const targetBuckets = opts.buckets || DEFAULT_BUCKETS
    const levelNames = store.levelNames
    const byLevel = levelNames.map(name => ({ name, count: 0 }))
    const counts = new Map()
    const templates = new Map()
    const durations = []
    let hasError = 0
    let redacted = 0
    let timeMissing = 0
    let oversized = 0
    let unknownLevel = 0
    let minTime = Infinity
    let maxTime = -Infinity
    let durSum = 0

    for (let k = 0; k < indices.length; k++) {
      const i = indices[k]
      counts.set(store.level[i], (counts.get(store.level[i]) || 0) + 1)
      const f = store.flags[i]
      if (f & FLAG.HAS_ERROR) hasError++
      if (f & FLAG.REDACTED) redacted++
      if (f & FLAG.TIME_MISSING) timeMissing++
      if (f & FLAG.OVERSIZED) oversized++
      if (f & FLAG.UNKNOWN_LEVEL) unknownLevel++
      const t = store.time[i]
      if (Number.isFinite(t)) {
        if (t < minTime) minTime = t
        if (t > maxTime) maxTime = t
      }
      const d = store.dur[i]
      if (Number.isFinite(d)) {
        durations.push(d)
        durSum += d
      }
      if (store.msg[i]) {
        const tpl = templateOf(store.msg[i])
        const entry = templates.get(tpl)
        if (entry) entry.count++
        else if (templates.size < 5000) templates.set(tpl, { template: tpl, count: 1, example: store.msg[i] })
      }
    }

    for (const [idx, count] of counts) byLevel[idx].count = count

    const span = Number.isFinite(minTime) && Number.isFinite(maxTime)
      ? { from: minTime, to: maxTime, ms: maxTime - minTime }
      : { from: null, to: null, ms: 0 }

    const buckets = []
    if (span.ms > 0 && indices.length > 0) {
      const width = niceStep(span.ms / targetBuckets)
      const start = Math.floor(span.from / width) * width
      const bucketCount = Math.max(1, Math.floor((span.to - start) / width) + 1)
      const capped = Math.min(bucketCount, 2000)
      const counts2 = new Uint32Array(capped)
      const perLevel = new Map()
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k]
        const t = store.time[i]
        if (!Number.isFinite(t)) continue
        const bidx = Math.min(capped - 1, Math.floor((t - start) / width))
        counts2[bidx]++
        let m = perLevel.get(bidx)
        if (!m) { m = new Map(); perLevel.set(bidx, m) }
        m.set(store.level[i], (m.get(store.level[i]) || 0) + 1)
      }
      for (let b = 0; b < capped; b++) {
        const levels = Object.create(null)
        const m = perLevel.get(b)
        if (m) for (const [li, c] of m) levels[levelNames[li]] = c
        buckets.push({ t0: start + b * width, t1: start + (b + 1) * width, total: counts2[b], levels })
      }
    }

    durations.sort((a, b) => a - b)
    const duration = durations.length
      ? {
          samples: durations.length,
          min: durations[0],
          max: durations[durations.length - 1],
          mean: durSum / durations.length,
          p50: percentile(durations, 50),
          p95: percentile(durations, 95),
          p99: percentile(durations, 99)
        }
      : null

    const topMessages = Array.from(templates.values())
      .sort((a, b) => b.count - a.count || a.template.localeCompare(b.template))
      .slice(0, TOP_MESSAGES)

    const seconds = span.ms > 0 ? span.ms / 1000 : 0

    return {
      count: indices.length,
      totalInStore: store.count,
      byLevel: byLevel.filter(l => l.count > 0),
      flags: { hasError, redacted, timeMissing, oversized, unknownLevel },
      errorRate: indices.length ? hasError / indices.length : 0,
      span,
      entriesPerSecond: seconds > 0 ? indices.length / seconds : null,
      buckets,
      bucketWidth: buckets.length ? buckets[0].t1 - buckets[0].t0 : null,
      topMessages,
      duration,
      distinctTemplates: templates.size,
      bytes: store.bytes
    }
  }

  return { summarize, templateOf, niceStep, percentile, DEFAULT_BUCKETS }
})
