'use strict'
/**
 * pino-lens — level table helpers.
 * MIT License. See lens/LICENSE.
 *
 * pino writes `level` as a number by default (lib/constants.js DEFAULT_LEVELS)
 * but a custom formatter may write a label string instead, and customLevels
 * can renumber or extend the set. Both shapes must be understood here.
 */

;(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.PinoLens = root.PinoLens || {}
    Object.assign(root.PinoLens, factory())
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Mirrors lib/constants.js in pino v10.
  const DEFAULT_LEVELS = Object.freeze({
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60
  })

  // Terminal-ish severity ramp. Index 0 is "unknown".
  const SEVERITY_ORDER = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

  function normalizeLevelTable (levels) {
    const table = Object.assign({}, DEFAULT_LEVELS)
    if (!levels) return table
    if (Array.isArray(levels)) {
      for (const l of levels) {
        if (l && typeof l.name === 'string' && Number.isFinite(l.value)) table[l.name] = l.value
      }
    } else if (typeof levels === 'object') {
      for (const [name, value] of Object.entries(levels)) {
        const num = typeof value === 'number' ? value : Number(value)
        if (typeof name === 'string' && Number.isFinite(num)) table[name] = num
      }
    }
    return table
  }

  function createLevelResolver (levels) {
    const table = normalizeLevelTable(levels)
    const byValue = new Map()
    for (const [name, num] of Object.entries(table)) {
      // First name wins for duplicate numbers (custom levels shadow defaults).
      if (!byValue.has(num)) byValue.set(num, name)
    }
    const names = Object.keys(table)

    /**
     * @param {*} value raw `level` field
     * @returns {{name: string, num: number|null, known: boolean}}
     */
    function resolve (value) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        const name = byValue.get(value)
        return { name: name || ('level:' + value), num: value, known: Boolean(name) }
      }
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (Object.prototype.hasOwnProperty.call(table, trimmed)) {
          return { name: trimmed, num: table[trimmed], known: true }
        }
        if (/^-?\d+$/.test(trimmed)) {
          const num = Number(trimmed)
          const name = byValue.get(num)
          return { name: name || ('level:' + num), num, known: Boolean(name) }
        }
        return { name: trimmed || 'unknown', num: null, known: false }
      }
      return { name: 'unknown', num: null, known: false }
    }

    function numbersFor (names) {
      const out = []
      for (const n of names) {
        if (Object.prototype.hasOwnProperty.call(table, n)) out.push(table[n])
      }
      return out
    }

    return { resolve, numbersFor, table, names }
  }

  return { DEFAULT_LEVELS, SEVERITY_ORDER, createLevelResolver, normalizeLevelTable }
})
