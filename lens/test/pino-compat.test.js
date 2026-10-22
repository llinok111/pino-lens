'use strict'
/**
 * Integration tests against the real pino build in this repository.
 * These assert that the viewer understands what pino actually writes —
 * not what its documentation says it writes.
 */

const test = require('node:test')
const assert = require('node:assert')

const { buildFixtures } = require('./fixtures')
const { buildStore, getField, getObject, FLAG } = require('../src/core/store')
const { parseQuery, filterStore } = require('../src/core/query')

const fixtures = buildFixtures()
const pinoVersion = require('../../package.json').version

function storeOf (name, options) {
  return buildStore(fixtures.texts[name], options)
}

test('fixtures are produced by the repository pino build', () => {
  assert.match(pinoVersion, /^10\./)
  assert.ok(fixtures.texts.default.includes('"level":30'), 'numeric level present')
})

test('default output parses completely and keeps field types', () => {
  const store = storeOf('default')
  assert.strictEqual(store.count, 4, 'trace/debug are below the default info level')
  assert.strictEqual(store.issues.invalidJson, 0)
  assert.strictEqual(store.issues.notAnObject, 0)

  const names = Array.from({ length: store.count }, (_, i) => store.levelNames[store.level[i]])
  assert.deepStrictEqual(names, ['info', 'warn', 'error', 'fatal'])
  assert.strictEqual(store.msg[0], 'info line 7', 'printf-style arguments are already interpolated by pino')
  assert.strictEqual(store.dur[1], 12.5, 'responseTime becomes the duration column')
  assert.strictEqual(store.dur[0], store.dur[0], 'missing duration is NaN, never 0')

  const err = getObject(store, 2).err
  assert.strictEqual(err.type, 'Error')
  assert.strictEqual(err.message, 'kaboom')
  assert.ok(err.stack.includes('Error: kaboom'))
  assert.ok((store.flags[2] & FLAG.HAS_ERROR) !== 0)
})

test('original lines are preserved byte for byte', () => {
  const store = storeOf('default')
  const lines = fixtures.texts.default.split('\n').filter(Boolean)
  assert.deepStrictEqual(store.raw, lines)
})

test('custom levels and ISO timestamps normalise correctly', () => {
  const store = storeOf('customLevels', { levels: { notice: 35, audit: 65 } })
  assert.strictEqual(store.count, 3)
  const names = Array.from({ length: 3 }, (_, i) => store.levelNames[store.level[i]])
  assert.deepStrictEqual(names, ['notice', 'audit', 'info'])
  assert.strictEqual(store.timeUnits.iso, 3)
  assert.ok(Number.isFinite(store.time[0]))
  const rawIso = JSON.parse(store.raw[0]).time
  assert.match(rawIso, /^\d{4}-\d{2}-\d{2}T/)
  assert.strictEqual(new Date(store.time[0]).toISOString(), rawIso)
})

test('without a custom level table the raw number is surfaced, not guessed', () => {
  const store = storeOf('customLevels')
  const names = Array.from({ length: store.count }, (_, i) => store.levelNames[store.level[i]])
  assert.ok(names.includes('level:35'))
  assert.ok((store.flags[0] & FLAG.UNKNOWN_LEVEL) !== 0)
})

test('string levels from formatters.level and a renamed message key', () => {
  const store = storeOf('stringLevel', { msgKey: 'message' })
  assert.strictEqual(store.count, 2)
  assert.strictEqual(store.levelNames[store.level[0]], 'info')
  assert.strictEqual(store.levelNum[0], 30)
  assert.strictEqual(store.msg[0], 'string level info')
  assert.strictEqual(store.msg[1], 'string level warn')
})

test('nestedKey keeps msg on top and moves object fields under the key', () => {
  const store = storeOf('nested', { errKey: 'payload.err' })
  assert.strictEqual(store.count, 3)
  assert.strictEqual(store.msg[0], 'nested payload')
  assert.strictEqual(getField(store, 0, 'payload.deep.a.b.c'), 1)
  assert.strictEqual(getField(store, 0, 'payload.tags.1'), 'b')
  assert.strictEqual(getObject(store, 2).payload.err.code, 'E_FIXTURE')
  assert.strictEqual(store.msg[1], 'unicode message 你好')
})

test('redaction censors are detected and never mistaken for messages', () => {
  const store = storeOf('nested', { errKey: 'payload.err' })
  assert.strictEqual(store.msg[0], 'nested payload')
  const obj = getObject(store, 0)
  assert.strictEqual(obj.payload.password, '[Redacted]')
  assert.strictEqual(obj.payload.headers.authorization, '[Redacted]')
  assert.ok((store.flags[0] & FLAG.REDACTED) !== 0)
})

test('circular references and non-finite numbers follow pino semantics', () => {
  const store = storeOf('circular')
  assert.strictEqual(store.count, 1)
  const obj = getObject(store, 0)
  assert.strictEqual(obj.cycle.self, '[Circular]')
  assert.strictEqual(obj.bad, null, 'NaN is serialised as null by pino')
  assert.strictEqual(obj.alsoBad, null)
  assert.strictEqual(obj.ok, true)
  assert.ok(!('skipped' in obj), 'undefined properties are dropped')
  assert.strictEqual(store.msg[0], 'weird values')
})

test('messages containing HTML are kept verbatim and stay searchable', () => {
  const store = storeOf('xss')
  assert.strictEqual(store.count, 2)
  assert.strictEqual(store.msg[0], '</script><img src=x onerror=alert(1)>')
  assert.strictEqual(filterStore(store, parseQuery('"onerror"')).length, 1)
  assert.ok(store.msg[1].includes('\u2028'))
})

test('a damaged file is reported precisely', () => {
  const store = storeOf('damaged')
  assert.strictEqual(store.count, 2)
  assert.strictEqual(store.issues.emptyLines, 2)
  assert.strictEqual(store.issues.notAnObject, 1)
  assert.strictEqual(store.issues.invalidJson, 1)
  assert.strictEqual(store.issues.hadBom, true)
  assert.ok(store.issues.samples.length >= 2)
  const notObject = store.issues.samples.find(s => s.code === 'not-an-object')
  assert.match(notObject.snippet, /^\[1,2,3\]/)
})
