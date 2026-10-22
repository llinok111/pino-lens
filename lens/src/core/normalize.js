'use strict'
/**
 * pino-lens — field normalisation for pino log records.
 * MIT License. See lens/LICENSE.
 *
 * Facts taken from the pino source (v10.4.0), not from documentation prose:
 *  - `level` is numeric by default (lib/constants.js) and may be a label when
 *    `formatters.level` is used.
 *  - `time` defaults to `Date.now()` (epoch milliseconds); `stdTimeFunctions.isoTime`
 *    writes an ISO-8601 string and `timestamp: false` omits the field entirely.
 *  - non-finite numbers are coerced to `null` before serialisation (lib/tools.js).
 *  - `undefined` and function values are dropped from the line.
 *  - circular structures fall back to a fixed placeholder string.
 */

;(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./levels'))
  } else {
    root.PinoLens = root.PinoLens || {}
    Object.assign(root.PinoLens, factory(root.PinoLens))
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (levelsMod) {
  const { createLevelResolver } = levelsMod

  const REDACTED_MARKERS = ['[Redacted]', '[REDACTED]', '***', '"[Redacted]"']
  const CIRCULAR_PLACEHOLDER = '[unable to serialize, circular reference is too complex to analyze]'

  // Field names commonly used for per-entry latency, in priority order.
  // Only names that are unambiguous with respect to pino's own fields.
  const DURATION_KEYS = [
    'responseTime', 'response_time', 'durationMs', 'duration_ms', 'duration',
    'elapsedMs', 'elapsed_ms', 'elapsed', 'latencyMs', 'latency', 'tookMs', 'took'
  ]

  /**
   * @param {object} [options]
   * @param {object|Array} [options.levels] custom level table (pino `customLevels`)
   * @param {string} [options.levelKey='level']
   * @param {string} [options.timeKey='time']
   * @param {string} [options.msgKey='msg']
   * @param {string} [options.errKey='err']
   */
  function createNormalizer (options) {
    const opts = options || {}
    const levelKey = opts.levelKey || 'level'
    const timeKey = opts.timeKey || 'time'
    const msgKey = opts.msgKey || 'msg'
    const errKey = opts.errKey || 'err'
    const levelResolver = createLevelResolver(opts.levels)

    /**
     * Read a dotted path so `nestedKey` layouts can be described without
     * re-shaping the record: `payload.msg`, `payload.err`, ...
     */
    function getPath (obj, path) {
      if (!obj || path.indexOf('.') === -1) return obj ? obj[path] : undefined
      let cur = obj
      for (const part of path.split('.')) {
        if (cur === null || typeof cur !== 'object') return undefined
        cur = cur[part]
      }
      return cur
    }

    /**
     * Resolve `time` to epoch milliseconds.
     * pino writes ms by default, but transports may re-scale (e.g. Logstash
     * consumers emit seconds, OTel nanoseconds). Units are reported so the UI
     * can warn instead of silently misplotting.
     */
    function resolveTime (value) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        const abs = Math.abs(value)
        if (abs >= 1e15) return { ms: value / 1e6, unit: 'ns', coerced: true }
        if (abs >= 1e14) return { ms: value / 1e3, unit: 'us', coerced: true }
        if (abs >= 1e12) return { ms: value, unit: 'ms', coerced: false }
        if (abs >= 1e9) return { ms: value * 1e3, unit: 's', coerced: true }
        return { ms: value * 1e3, unit: 's?', coerced: true }
      }
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (/^\d{10,}$/.test(trimmed)) return resolveTime(Number(trimmed))
        const parsed = Date.parse(trimmed)
        if (Number.isFinite(parsed)) return { ms: parsed, unit: 'iso', coerced: false }
        return { ms: null, unit: 'unparsed', coerced: false }
      }
      return { ms: null, unit: 'missing', coerced: false }
    }

    /** Convert a message field of any serialisable type to display text. */
    function resolveMessage (value) {
      if (value === undefined || value === null) return { text: '', isObject: false }
      if (typeof value === 'string') return { text: value, isObject: false }
      if (typeof value === 'number' || typeof value === 'boolean') {
        return { text: String(value), isObject: false }
      }
      if (typeof value === 'object') {
        try {
          return { text: JSON.stringify(value), isObject: true }
        } catch (err) {
          return { text: '[unserialisable message]', isObject: true }
        }
      }
      return { text: String(value), isObject: false }
    }

    /** Normalise pino's serialised error (`err` via pino-std-serializers). */
    function resolveError (value) {
      if (value === undefined || value === null) return null
      if (typeof value === 'string') {
        return { type: null, message: value, stack: null, code: null }
      }
      if (typeof value !== 'object') {
        return { type: null, message: String(value), stack: null, code: null }
      }
      return {
        type: typeof value.type === 'string' ? value.type : null,
        message: typeof value.message === 'string' ? value.message : null,
        stack: typeof value.stack === 'string' ? value.stack : null,
        code: value.code === undefined || value.code === null ? null : value.code
      }
    }

    /** Detect a declared latency field. Returns milliseconds or null. */
    function resolveDuration (obj) {
      if (!obj || typeof obj !== 'object') return null
      for (const key of DURATION_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue
        const raw = obj[key]
        const num = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN)
        if (Number.isFinite(num) && num >= 0) return num
      }
      return null
    }

    function hasRedacted (obj) {
      // Shallow scan is enough: redaction paths are applied to top-level paths
      // and nested paths both surface as the censor marker at some depth.
      return containsMarker(obj, 0)
    }

    function containsMarker (value, depth) {
      if (depth > 3 || value === null || value === undefined) return false
      if (typeof value === 'string') return REDACTED_MARKERS.includes(value)
      if (typeof value !== 'object') return false
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length && i < 32; i++) {
          if (containsMarker(value[i], depth + 1)) return true
        }
        return false
      }
      for (const key of Object.keys(value)) {
        if (containsMarker(value[key], depth + 1)) return true
      }
      return false
    }

    /**
     * Project a raw record onto the canonical entry shape used by the store.
     * @param {object} obj parsed JSON object
     */
    function normalize (obj) {
      const level = levelResolver.resolve(getPath(obj, levelKey))
      const time = resolveTime(getPath(obj, timeKey))
      const msg = resolveMessage(getPath(obj, msgKey))
      const err = resolveError(getPath(obj, errKey))
      return {
        levelName: level.name,
        levelNum: level.num,
        levelKnown: level.known,
        timeMs: time.ms,
        timeUnit: time.unit,
        timeCoerced: time.coerced,
        msg: msg.text,
        msgIsObject: msg.isObject,
        err,
        durMs: resolveDuration(obj),
        redacted: hasRedacted(obj)
      }
    }

    return {
      normalize,
      getPath,
      resolveTime,
      resolveMessage,
      resolveError,
      resolveDuration,
      levelResolver,
      keys: { levelKey, timeKey, msgKey, errKey }
    }
  }

  return {
    createNormalizer,
    REDACTED_MARKERS,
    CIRCULAR_PLACEHOLDER,
    DURATION_KEYS
  }
})
