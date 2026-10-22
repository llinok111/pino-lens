'use strict'
/**
 * pino-lens — export helpers.
 * MIT License. See lens/LICENSE.
 *
 * NDJSON export writes the *original* lines back out, so an exported file is
 * byte-identical to the input slice and can be re-ingested by any pino tool.
 * CSV export is lossy by nature: nested values become JSON strings and the
 * spreadsheet-injection guard prefixes risky leading characters.
 */

;(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./store'))
  } else {
    root.PinoLens = root.PinoLens || {}
    Object.assign(root.PinoLens, factory(root.PinoLens))
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (storeMod) {
  const { getObject } = storeMod

  const DEFAULT_COLUMNS = ['time_iso', 'level', 'msg', 'duration_ms']
  const RISKY_PREFIX = /^[=+\-@\t\r]/

  function csvEscape (value, guard) {
    if (value === undefined || value === null) return ''
    let s = typeof value === 'string' ? value : String(value)
    if (guard && RISKY_PREFIX.test(s)) s = "'" + s
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }

  function cellValue (store, i, column) {
    if (column === 'time_iso') {
      const t = store.time[i]
      return Number.isFinite(t) ? new Date(t).toISOString() : ''
    }
    if (column === 'level') return store.levelNames[store.level[i]]
    if (column === 'msg') return store.msg[i]
    if (column === 'duration_ms') {
      const d = store.dur[i]
      return Number.isFinite(d) ? d : ''
    }
    if (column === 'line') return i + 1
    const obj = getObject(store, i)
    if (!obj) return ''
    let value = obj
    for (const part of column.split('.')) {
      if (value === null || typeof value !== 'object') return ''
      value = value[part]
    }
    if (value === undefined || value === null) return ''
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value)
      } catch (err) {
        return '[unserialisable]'
      }
    }
    return value
  }

  /**
   * @param {object} store
   * @param {Int32Array|number[]} indices
   * @param {{columns?: string[], bom?: boolean, guard?: boolean, limit?: number}} [options]
   */
  function toCSV (store, indices, options) {
    const opts = options || {}
    const columns = opts.columns && opts.columns.length ? opts.columns : DEFAULT_COLUMNS
    const guard = opts.guard !== false
    const bom = opts.bom !== false
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, indices.length) : indices.length
    const rows = [columns.map(c => csvEscape(c, false)).join(',')]
    for (let k = 0; k < limit; k++) {
      const i = indices[k]
      rows.push(columns.map(c => csvEscape(cellValue(store, i, c), guard)).join(','))
    }
    return (bom ? '\uFEFF' : '') + rows.join('\r\n') + '\r\n'
  }

  /** Faithful NDJSON export of the given index set. */
  function toNDJSON (store, indices, options) {
    const opts = options || {}
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, indices.length) : indices.length
    const out = new Array(limit)
    for (let k = 0; k < limit; k++) out[k] = store.raw[indices[k]]
    return out.join('\n') + (opts.trailingNewline === false ? '' : '\n')
  }

  /** JSON export of the statistics panel plus provenance metadata. */
  function toSummaryJSON (summary, meta) {
    return JSON.stringify({ tool: 'pino-lens', version: meta && meta.version ? meta.version : null, meta: meta || {}, summary }, null, 2)
  }

  return { toCSV, toNDJSON, toSummaryJSON, cellValue, csvEscape, DEFAULT_COLUMNS }
})
