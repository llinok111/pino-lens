'use strict'
/**
 * pino-lens — tolerant NDJSON reader.
 * MIT License. See lens/LICENSE.
 *
 * pino's write path (lib/proto.js `_asJson`) always appends a trailing newline
 * via `endSym`, and string values are JSON-escaped, so a log line can never
 * contain a raw newline. Files can still be damaged in practice: a process
 * killed mid-write leaves a truncated tail, Windows editors insert CRLF,
 * PowerShell prepends a BOM, and transports sometimes interleave blank lines.
 * Every one of those cases is reported instead of silently dropped.
 */

;(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.PinoLens = root.PinoLens || {}
    Object.assign(root.PinoLens, factory())
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_REPORTED = 50

  /**
   * Split a text blob into lines without using a global regex (a 50 MB file
   * would otherwise allocate one huge intermediate array of matches).
   * @param {string} text
   * @returns {{lines: string[], hadBom: boolean, trailingNewline: boolean}}
   */
  function splitLines (text) {
    if (typeof text !== 'string') throw new TypeError('splitLines expects a string')
    let hadBom = false
    let body = text
    if (body.charCodeAt(0) === 0xfeff) {
      hadBom = true
      body = body.slice(1)
    }
    const lines = []
    let start = 0
    const len = body.length
    for (let i = 0; i < len; i++) {
      if (body.charCodeAt(i) === 10) {
        let end = i
        if (end > start && body.charCodeAt(end - 1) === 13) end--
        lines.push(body.slice(start, end))
        start = i + 1
      }
    }
    const trailingNewline = start === len && len > 0
    if (start < len) lines.push(body.slice(start))
    return { lines, hadBom, trailingNewline }
  }

  /**
   * Parse one line. Never throws.
   * @param {string} line
   * @param {number} lineNo 1-based
   */
  function parseLine (line, lineNo) {
    if (line === undefined || line.trim() === '') {
      return { ok: false, code: 'empty', lineNo, message: 'empty line' }
    }
    let value
    try {
      value = JSON.parse(line)
    } catch (err) {
      return {
        ok: false,
        code: 'invalid-json',
        lineNo,
        message: err && err.message ? err.message : 'invalid JSON',
        snippet: line.length > 160 ? line.slice(0, 160) + '…' : line
      }
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return {
        ok: false,
        code: 'not-an-object',
        lineNo,
        message: 'line is valid JSON but not an object',
        snippet: line.length > 160 ? line.slice(0, 160) + '…' : line
      }
    }
    return { ok: true, value, lineNo }
  }

  /**
   * Scan a blob and report parse health without keeping parsed objects.
   * @param {string} text
   * @param {{maxLineBytes?: number}} [options]
   */
  function scan (text, options) {
    const opts = options || {}
    const maxLineBytes = opts.maxLineBytes || 256 * 1024
    const split = splitLines(text)
    const issues = {
      totalLines: split.lines.length,
      emptyLines: 0,
      invalidJson: 0,
      notAnObject: 0,
      oversizedLines: 0,
      hadBom: split.hadBom,
      trailingNewline: split.trailingNewline,
      samples: []
    }
    let valid = 0
    for (let i = 0; i < split.lines.length; i++) {
      const line = split.lines[i]
      if (line.length > maxLineBytes) issues.oversizedLines++
      const res = parseLine(line, i + 1)
      if (res.ok) {
        valid++
        continue
      }
      if (res.code === 'empty') issues.emptyLines++
      else if (res.code === 'invalid-json') issues.invalidJson++
      else issues.notAnObject++
      if (issues.samples.length < MAX_REPORTED) {
        issues.samples.push({ lineNo: res.lineNo, code: res.code, message: res.message, snippet: res.snippet })
      }
    }
    return { lines: split.lines, valid, issues }
  }

  return { splitLines, parseLine, scan, MAX_REPORTED }
})
