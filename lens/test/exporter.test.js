'use strict'
const test = require('node:test')
const assert = require('node:assert')

const { buildStore } = require('../src/core/store')
const { parseQuery, filterStore } = require('../src/core/query')
const { toCSV, toNDJSON, toSummaryJSON, cellValue } = require('../src/core/exporter')

const T0 = 1792690000000
const RAW = [
  { level: 30, time: T0, msg: 'plain message', host: 'a' },
  { level: 50, time: T0 + 1000, msg: 'needs, quoting "and" commas', host: 'b', responseTime: 12.5 },
  { level: 40, time: T0 + 2000, msg: '=SUM(A1:A2)', host: 'c', nested: { deep: [1, 2, 3] } },
  { level: 40, time: T0 + 3000, msg: '+cmd|calc', host: 'd' }
].map(o => JSON.stringify(o))

const store = buildStore(RAW.join('\n') + '\n')
const all = filterStore(store, parseQuery(''))

test('CSV starts with a BOM, a header and one row per entry', () => {
  const csv = toCSV(store, all)
  assert.strictEqual(csv.charCodeAt(0), 0xfeff)
  const rows = csv.replace(/^\uFEFF/, '').trim().split('\r\n')
  assert.strictEqual(rows.length, 5)
  assert.strictEqual(rows[0], 'time_iso,level,msg,duration_ms')
})

test('CSV escapes quotes, commas and newlines', () => {
  const csv = toCSV(store, all, { bom: false })
  assert.ok(csv.includes('"needs, quoting ""and"" commas"'), 'quotes doubled and value wrapped')
})

test('CSV blocks spreadsheet formula injection by default', () => {
  const csv = toCSV(store, all, { bom: false })
  assert.ok(csv.includes("'=SUM(A1:A2)"), 'leading = is prefixed')
  assert.ok(csv.includes("'+cmd|calc"), 'leading + is prefixed')
  const unguarded = toCSV(store, all, { bom: false, guard: false })
  assert.ok(unguarded.includes('=SUM(A1:A2)') && !unguarded.includes("'=SUM"))
})

test('CSV can project extra columns, including nested paths', () => {
  const csv = toCSV(store, all, { bom: false, columns: ['level', 'msg', 'host', 'nested.deep'] })
  assert.ok(csv.startsWith('level,msg,host,nested.deep'))
  assert.ok(csv.includes('[1,2,3]'), 'objects become JSON strings')
  assert.strictEqual(cellValue(store, 0, 'duration_ms'), '')
  assert.strictEqual(cellValue(store, 1, 'duration_ms'), 12.5)
})

test('CSV honours a row limit', () => {
  const csv = toCSV(store, all, { bom: false, limit: 2 })
  assert.strictEqual(csv.trim().split('\r\n').length, 3)
})

test('NDJSON export is byte-identical to the input slice', () => {
  const ndjson = toNDJSON(store, all)
  assert.strictEqual(ndjson, RAW.join('\n') + '\n')
  const partial = toNDJSON(store, all.subarray(1, 3), { trailingNewline: false })
  assert.strictEqual(partial, RAW[1] + '\n' + RAW[2])
})

test('summary JSON is machine readable and carries provenance', () => {
  const payload = JSON.parse(toSummaryJSON({ count: 4 }, { title: 'demo', version: '0.1.0' }))
  assert.strictEqual(payload.tool, 'pino-lens')
  assert.strictEqual(payload.meta.title, 'demo')
  assert.strictEqual(payload.summary.count, 4)
})
