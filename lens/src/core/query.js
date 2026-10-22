'use strict'
/**
 * pino-lens — query parsing, filtering and sorting.
 * MIT License. See lens/LICENSE.
 *
 * The query language is deliberately small and total: every token either
 * compiles into a predicate or produces an error message that the UI shows.
 * Invalid input never throws and never silently widens the result set.
 *
 *   level>=warn            numeric level floor (uses `level` numbers)
 *   level=error,warn       explicit level set
 *   msg~"timeout"          message substring, case-insensitive
 *   -"health"              exclude messages containing "health"
 *   time>=2026-10-23T02:00 time window (ISO string or epoch ms)
 *   duration>250           latency field, milliseconds
 *   service=api-gateway    exact field match
 *   host~api               field substring
 *   trace exists           field presence
 */

;(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./store'))
  } else {
    root.PinoLens = root.PinoLens || {}
    Object.assign(root.PinoLens, factory(root.PinoLens))
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (storeMod) {
  const { getField } = storeMod

  const LEVEL_ALIASES = { dur: 'duration', latency: 'duration', lvl: 'level', message: 'msg' }

  function emptyQuery () {
    return { levelMin: null, levelMax: null, levelSet: null, levelExclude: null, from: null, to: null, text: [], fields: [], errors: [] }
  }

  /** Split on whitespace while honouring double/single quotes. */
  function tokenize (input) {
    const tokens = []
    let i = 0
    const s = String(input || '')
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++
      if (i >= s.length) break
      let negate = false
      if (s[i] === '-' && i + 1 < s.length && !/\s/.test(s[i + 1])) {
        negate = true
        i++
      }
      let buf = ''
      let quote = null
      while (i < s.length) {
        const ch = s[i]
        if (quote) {
          if (ch === quote) { quote = null; i++; continue }
          buf += ch
          i++
          continue
        }
        if (ch === '"' || ch === "'") { quote = ch; i++; continue }
        if (/\s/.test(ch)) break
        buf += ch
        i++
      }
      tokens.push({ text: buf, negate, quoted: buf.length > 0 })
    }
    return tokens
  }

  function toNumberish (value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
    return null
  }

  function parseTimeValue (value) {
    const num = toNumberish(value)
    if (num !== null) {
      return Math.abs(num) >= 1e12 ? num : num * 1000
    }
    const parsed = Date.parse(String(value))
    return Number.isFinite(parsed) ? parsed : null
  }

  /**
   * @param {string} input
   * @returns {object} query object (never throws)
   */
  function parseQuery (input, options) {
    const levelTable = levelTableOf(options && options.levels)
    const query = emptyQuery()
    const raw = String(input || '').trim()
    if (!raw) return query
    const tokens = tokenize(raw)
    for (let idx = 0; idx < tokens.length; idx++) {
      const token = tokens[idx]
      const text = token.text
      if (!text) continue

      // `field exists`
      if (text.toLowerCase() === 'exists' && idx > 0 && query.fields.length && query.fields[query.fields.length - 1].op === '__pending_exists__') {
        query.fields[query.fields.length - 1].op = 'exists'
        continue
      }

      const match = /^([A-Za-z_][\w.$-]*)(>=|<=|!=|!~|=|~|>|<)(.*)$/.exec(text)
      if (!match) {
        if (/^[A-Za-z_][\w.$-]*$/.test(text) && idx + 1 < tokens.length && tokens[idx + 1].text.toLowerCase() === 'exists') {
          query.fields.push({ key: text, op: '__pending_exists__', value: null, negate: token.negate })
          continue
        }
        query.text.push({ value: text.toLowerCase(), negate: token.negate })
        continue
      }

      const key = LEVEL_ALIASES[match[1]] || match[1]
      const op = match[2]
      let value = match[3]
      if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
        value = value.slice(1, -1)
      }
      if (value === '') {
        query.errors.push({ token: text, message: 'missing value after operator' })
        continue
      }

      if (key === 'level') {
        const names = value.split(',').map(v => v.trim()).filter(Boolean)
        const nums = names.map(n => toNumberish(n) !== null ? toNumberish(n) : levelNumberFromName(n, levelTable))
        if (nums.some(n => n === null)) {
          query.errors.push({ token: text, message: 'unknown level name: ' + value })
          continue
        }
        if (op === '=') query.levelSet = (query.levelSet || []).concat(names)
        else if (op === '>=') query.levelMin = Math.max(query.levelMin === null ? -Infinity : query.levelMin, Math.min(...nums))
        else if (op === '>') query.levelMin = Math.max(query.levelMin === null ? -Infinity : query.levelMin, Math.min(...nums) + 1)
        else if (op === '<=') query.levelMax = Math.min(query.levelMax === null ? Infinity : query.levelMax, Math.max(...nums))
        else if (op === '<') query.levelMax = Math.min(query.levelMax === null ? Infinity : query.levelMax, Math.max(...nums) - 1)
        else if (op === '!=') query.levelExclude = (query.levelExclude || []).concat(names)
        else query.errors.push({ token: text, message: 'operator ' + op + ' not supported for level' })
        continue
      }

      if (key === 'time') {
        const ms = parseTimeValue(value)
        if (ms === null) {
          query.errors.push({ token: text, message: 'unparsable time value: ' + value })
          continue
        }
        if (op === '>=') query.from = ms
        else if (op === '>') query.from = ms + 1
        else if (op === '<=') query.to = ms + 1
        else if (op === '<') query.to = ms
        else if (op === '=') {
          query.from = ms
          query.to = ms + 1000
        } else {
          query.errors.push({ token: text, message: 'operator ' + op + ' not supported for time' })
        }
        continue
      }

      if (key === 'msg' && (op === '~' || op === '=' || op === '!=' || op === '!~')) {
        query.text.push({ value: value.toLowerCase(), negate: token.negate || op === '!=' || op === '!~' })
        continue
      }

      query.fields.push({ key, op, value, negate: token.negate })
    }

    // Drop dangling `field exists` placeholders that never saw the keyword.
    query.fields = query.fields.filter(f => f.op !== '__pending_exists__')
    return query
  }

  function levelTableOf (levels) {
    const table = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }
    if (Array.isArray(levels)) {
      for (const l of levels) if (l && l.name && Number.isFinite(l.value)) table[l.name] = l.value
    } else if (levels && typeof levels === 'object') {
      for (const [name, value] of Object.entries(levels)) {
        const num = Number(value)
        if (Number.isFinite(num)) table[name] = num
      }
    }
    return table
  }

  function levelNumberFromName (name, table) {
    const levels = table || levelTableOf(null)
    return Object.prototype.hasOwnProperty.call(levels, name) ? levels[name] : null
  }

  /**
   * Compile a query into a predicate over store indices.
   * Field predicates re-parse raw lines (see store.getField).
   */
  function compile (query, store) {
    const textTerms = query.text || []
    const fieldFilters = (query.fields || []).filter(f => f.op !== '__pending_exists__')
    const hasLevelRange = query.levelMin !== null || query.levelMax !== null
    const levelSet = query.levelSet && query.levelSet.length ? new Set(query.levelSet) : null
    const levelExclude = query.levelExclude && query.levelExclude.length ? new Set(query.levelExclude) : null

    return function predicate (i) {
      if (hasLevelRange) {
        const num = store.levelNum[i]
        if (!Number.isFinite(num)) return false
        if (query.levelMin !== null && num < query.levelMin) return false
        if (query.levelMax !== null && num > query.levelMax) return false
      }
      if (levelSet && !levelSet.has(store.levelNames[store.level[i]])) return false
      if (levelExclude && levelExclude.has(store.levelNames[store.level[i]])) return false
      if (query.from !== null) {
        const t = store.time[i]
        if (!Number.isFinite(t) || t < query.from) return false
      }
      if (query.to !== null) {
        const t = store.time[i]
        if (!Number.isFinite(t) || t >= query.to) return false
      }
      for (let k = 0; k < textTerms.length; k++) {
        const term = textTerms[k]
        const hit = store.msgLower[i].indexOf(term.value) !== -1
        if (term.negate ? hit : !hit) return false
      }
      for (let k = 0; k < fieldFilters.length; k++) {
        if (!matchField(store, i, fieldFilters[k])) return false
      }
      return true
    }
  }

  function matchField (store, i, filter) {
    const actual = filter.key === 'duration' ? store.dur[i] : getField(store, i, filter.key)
    let result
    switch (filter.op) {
      case 'exists':
        result = actual !== undefined && actual !== null
        break
      case '=':
        result = looseEquals(actual, filter.value)
        break
      case '!=':
        result = !looseEquals(actual, filter.value)
        break
      case '~':
        result = actual !== undefined && actual !== null && String(actual).toLowerCase().includes(String(filter.value).toLowerCase())
        break
      case '!~':
        result = actual === undefined || actual === null || !String(actual).toLowerCase().includes(String(filter.value).toLowerCase())
        break
      case '>': case '>=': case '<': case '<=': {
        const left = typeof actual === 'number' ? actual : toNumberish(actual)
        const right = toNumberish(filter.value)
        if (left === null || right === null) {
          result = false
        } else if (filter.op === '>') result = left > right
        else if (filter.op === '>=') result = left >= right
        else if (filter.op === '<') result = left < right
        else result = left <= right
        break
      }
      default:
        result = false
    }
    return filter.negate ? !result : result
  }

  function looseEquals (actual, expected) {
    if (actual === undefined) return false
    if (actual === null) return expected === 'null' || expected === ''
    if (typeof actual === 'number') {
      const num = toNumberish(expected)
      return num !== null ? actual === num : String(actual) === expected
    }
    if (typeof actual === 'object') {
      try {
        return JSON.stringify(actual) === expected
      } catch (err) {
        return false
      }
    }
    return String(actual) === expected
  }

  /**
   * @returns {Int32Array} matching indices in ascending line order
   */
  function filterStore (store, query) {
    const predicate = compile(query || emptyQuery(), store)
    const out = new Int32Array(store.count)
    let n = 0
    for (let i = 0; i < store.count; i++) {
      if (predicate(i)) out[n++] = i
    }
    return out.subarray(0, n)
  }

  const SORT_KEYS = ['line', 'time', 'level', 'msg', 'duration']

  function comparatorFor (store, key, dir) {
    const sign = dir === 'desc' ? -1 : 1
    const missingLast = (a, b) => (Number.isNaN(a) && Number.isNaN(b) ? 0 : Number.isNaN(a) ? 1 : Number.isNaN(b) ? -1 : 0)

    if (key === 'duration') {
      return (a, b) => {
        const m = missingLast(store.dur[a], store.dur[b])
        if (m !== 0) return m
        const d = store.dur[a] - store.dur[b]
        return d !== 0 ? sign * d : a - b
      }
    }
    if (key === 'time') {
      return (a, b) => {
        const m = missingLast(store.time[a], store.time[b])
        if (m !== 0) return m
        const d = store.time[a] - store.time[b]
        return d !== 0 ? sign * d : a - b
      }
    }
    if (key === 'level') {
      return (a, b) => {
        const m = missingLast(store.levelNum[a], store.levelNum[b])
        if (m !== 0) return m
        const d = store.levelNum[a] - store.levelNum[b]
        return d !== 0 ? sign * d : a - b
      }
    }
    if (key === 'msg') {
      return (a, b) => {
        const left = store.msgLower[a]
        const right = store.msgLower[b]
        if (left < right) return -sign
        if (left > right) return sign
        return a - b
      }
    }
    // default: line order
    return (a, b) => (dir === 'desc' ? b - a : a - b)
  }

  /**
   * Sort a filtered index array. Missing numeric values stay last in both
   * directions so `duration desc` does not fill the top with NaN rows.
   */
  function sortIndices (store, indices, key, dir) {
    const cmp = comparatorFor(store, SORT_KEYS.includes(key) ? key : 'line', dir)
    return Int32Array.from(indices).sort(cmp)
  }

  /** Serialise a query back to the language above (used for shareable links). */
  function stringifyQuery (query) {
    const parts = []
    if (query.levelMin !== null) parts.push('level>=' + (query.levelMax !== null && query.levelMin === query.levelMax ? query.levelMin : query.levelMin))
    if (query.levelMax !== null && query.levelMin === null) parts.push('level<=' + query.levelMax)
    if (query.levelSet) for (const l of query.levelSet) parts.push('level=' + l)
    if (query.levelExclude) for (const l of query.levelExclude) parts.push('level!=' + l)
    if (query.from !== null) parts.push('time>=' + new Date(query.from).toISOString())
    if (query.to !== null) parts.push('time<' + new Date(query.to).toISOString())
    for (const t of query.text) parts.push((t.negate ? '-' : '') + quoteIfNeeded(t.value))
    for (const f of query.fields) {
      if (f.op === 'exists') parts.push(f.key + ' exists')
      else parts.push(f.key + f.op + quoteIfNeeded(f.value))
    }
    return parts.join(' ')
  }

  /**
   * Merge UI-level facets (level chips, timeline brush) into a parsed query.
   * Conflicting facets are intersected, never widened: a time brush can only
   * narrow an existing `time>=` predicate.
   *
   * @param {object} base query from parseQuery
   * @param {{levels?: string[]|Set<string>|null, from?: number|null, to?: number|null}} facets
   */
  function combine (base, facets) {
    const q = Object.assign(emptyQuery(), base)
    q.text = (base && base.text ? base.text : []).slice()
    q.fields = (base && base.fields ? base.fields : []).slice()
    q.errors = (base && base.errors ? base.errors : []).slice()
    if (!facets) return q
    if (facets.levels && (facets.levels.size === undefined ? facets.levels.length > 0 : facets.levels.size > 0)) {
      const list = Array.from(facets.levels)
      q.levelSet = q.levelSet && q.levelSet.length ? q.levelSet.filter(l => list.includes(l)) : list
    }
    if (facets.from !== null && facets.from !== undefined) {
      q.from = q.from === null ? facets.from : Math.max(q.from, facets.from)
    }
    if (facets.to !== null && facets.to !== undefined) {
      q.to = q.to === null ? facets.to : Math.min(q.to, facets.to)
    }
    return q
  }

  function quoteIfNeeded (value) {
    const s = String(value)
    return /[\s"']/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s
  }

  return {
    emptyQuery,
    parseQuery,
    compile,
    filterStore,
    sortIndices,
    stringifyQuery,
    combine,
    tokenize,
    SORT_KEYS,
    matchField
  }
})
