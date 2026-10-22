'use strict'
/**
 * pino-lens — columnar store.
 * MIT License. See lens/LICENSE.
 *
 * Design notes:
 *  - Only the *original line text* is kept for fidelity (detail view, NDJSON
 *    export, and re-parsing on demand). Parsed objects are not retained, which
 *    keeps 250k+ entry files usable in a browser tab.
 *  - Hot filter/sort keys are lifted into typed arrays so a full pass over
 *    100k entries costs a few milliseconds and allocates nothing per entry.
 *  - Field predicates (e.g. `host=api-1`) need the object shape, so those
 *    re-parse the line lazily with a bounded LRU-ish cache.
 */

;(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./ndjson'), require('./normalize'))
  } else {
    root.PinoLens = root.PinoLens || {}
    Object.assign(root.PinoLens, factory(root.PinoLens, root.PinoLens))
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ndjsonMod, normalizeMod) {
  const { parseLine, splitLines } = ndjsonMod
  const { createNormalizer } = normalizeMod

  const FLAG = Object.freeze({
    HAS_ERROR: 1,
    REDACTED: 2,
    MSG_OBJECT: 4,
    TIME_MISSING: 8,
    TIME_COERCED: 16,
    OVERSIZED: 32,
    UNKNOWN_LEVEL: 64
  })

  const MAX_ISSUE_SAMPLES = 50
  const MAX_COLUMN_SAMPLES = 8
  const FIELD_CACHE_LIMIT = 20000

  function typeOfValue (value) {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    return typeof value
  }

  /**
   * @param {string} text NDJSON blob
   * @param {object} [options]
   * @param {object|Array} [options.levels] custom level table
   * @param {number} [options.maxLineBytes=262144]
   * @param {number} [options.maxEntries=0] 0 = unlimited
   */
  function buildStore (text, options) {
    const opts = options || {}
    const maxLineBytes = opts.maxLineBytes || 256 * 1024
    const normalizer = createNormalizer(opts)
    const split = Array.isArray(text) ? { lines: text, hadBom: false, trailingNewline: true } : splitLines(text)

    const raw = []
    const msg = []
    const msgLower = []
    const levelNames = []
    const levelIndex = new Map()
    const level = []
    const levelNums = []
    const times = []
    const durs = []
    const flags = []
    const columns = new Map()
    const issues = {
      totalLines: split.lines.length,
      emptyLines: 0,
      invalidJson: 0,
      notAnObject: 0,
      oversizedLines: 0,
      skippedByLimit: 0,
      hadBom: Boolean(split.hadBom),
      trailingNewline: Boolean(split.trailingNewline),
      samples: []
    }
    const timeUnits = Object.create(null)
    let bytes = 0

    function indexOfLevel (name) {
      let idx = levelIndex.get(name)
      if (idx === undefined) {
        idx = levelNames.length
        levelNames.push(name)
        levelIndex.set(name, idx)
      }
      return idx
    }

    function recordIssue (lineNo, code, message, snippet) {
      if (issues.samples.length < MAX_ISSUE_SAMPLES) {
        issues.samples.push({ lineNo, code, message, snippet })
      }
    }

    function observeColumns (obj) {
      for (const key of Object.keys(obj)) {
        let col = columns.get(key)
        if (!col) {
          col = { key, count: 0, types: Object.create(null), samples: [], distinct: 0 }
          columns.set(key, col)
        }
        col.count++
        const t = typeOfValue(obj[key])
        col.types[t] = (col.types[t] || 0) + 1
        if (col.samples.length < MAX_COLUMN_SAMPLES && (t === 'string' || t === 'number' || t === 'boolean')) {
          const candidate = String(obj[key])
          if (candidate.length <= 80 && !col.samples.includes(candidate)) {
            col.samples.push(candidate)
            col.distinct++
          }
        }
      }
    }

    for (let i = 0; i < split.lines.length; i++) {
      const line = split.lines[i]
      if (opts.maxEntries && raw.length >= opts.maxEntries) {
        issues.skippedByLimit = split.lines.length - i
        break
      }
      if (line.length > maxLineBytes) issues.oversizedLines++
      const parsed = parseLine(line, i + 1)
      if (!parsed.ok) {
        if (parsed.code === 'empty') issues.emptyLines++
        else if (parsed.code === 'invalid-json') issues.invalidJson++
        else issues.notAnObject++
        recordIssue(parsed.lineNo, parsed.code, parsed.message, parsed.snippet)
        continue
      }
      const entry = normalizer.normalize(parsed.value)
      observeColumns(parsed.value)

      let f = 0
      if (entry.err) f |= FLAG.HAS_ERROR
      if (entry.redacted) f |= FLAG.REDACTED
      if (entry.msgIsObject) f |= FLAG.MSG_OBJECT
      if (entry.timeMs === null) f |= FLAG.TIME_MISSING
      if (entry.timeCoerced) f |= FLAG.TIME_COERCED
      if (line.length > maxLineBytes) f |= FLAG.OVERSIZED
      if (!entry.levelKnown) f |= FLAG.UNKNOWN_LEVEL

      raw.push(line)
      msg.push(entry.msg)
      msgLower.push(entry.msg ? entry.msg.toLowerCase() : '')
      level.push(indexOfLevel(entry.levelName))
      levelNums.push(entry.levelNum === null ? NaN : entry.levelNum)
      times.push(entry.timeMs === null ? NaN : entry.timeMs)
      durs.push(entry.durMs === null ? NaN : entry.durMs)
      flags.push(f)
      bytes += line.length + 1
      timeUnits[entry.timeUnit] = (timeUnits[entry.timeUnit] || 0) + 1
    }

    const columnList = Array.from(columns.values()).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))

    const store = {
      count: raw.length,
      raw,
      msg,
      msgLower,
      level: Uint8Array.from(level),
      levelNum: Float64Array.from(levelNums),
      time: Float64Array.from(times),
      dur: Float64Array.from(durs),
      flags: Uint8Array.from(flags),
      levelNames,
      columns: columnList,
      issues,
      timeUnits,
      bytes,
      normalizer,
      fieldCache: new Map(),
      fieldCacheHits: 0,
      fieldCacheMisses: 0
    }

    return store
  }

  /** Parse the raw line behind an entry, with a bounded cache. */
  function getObject (store, i) {
    const cached = store.fieldCache.get(i)
    if (cached !== undefined) {
      store.fieldCacheHits++
      return cached
    }
    store.fieldCacheMisses++
    let obj = null
    try {
      obj = JSON.parse(store.raw[i])
    } catch (err) {
      obj = null
    }
    if (store.fieldCache.size >= FIELD_CACHE_LIMIT) store.fieldCache.clear()
    store.fieldCache.set(i, obj)
    return obj
  }

  function getField (store, i, path) {
    const obj = getObject(store, i)
    if (!obj) return undefined
    if (path.indexOf('.') === -1) return obj[path]
    let cur = obj
    for (const part of path.split('.')) {
      if (cur === null || typeof cur !== 'object') return undefined
      cur = cur[part]
    }
    return cur
  }

  function hasFlag (store, i, flag) {
    return (store.flags[i] & flag) !== 0
  }

  function levelNameOf (store, i) {
    return store.levelNames[store.level[i]]
  }

  return {
    buildStore,
    getObject,
    getField,
    hasFlag,
    levelNameOf,
    FLAG,
    MAX_ISSUE_SAMPLES,
    MAX_COLUMN_SAMPLES
  }
})
