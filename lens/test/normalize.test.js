'use strict'
const test = require('node:test')
const assert = require('node:assert')

const { createNormalizer, REDACTED_MARKERS } = require('../src/core/normalize')

const n = createNormalizer()

test('numeric levels map to pino default names', () => {
  assert.strictEqual(n.normalize({ level: 10 }).levelName, 'trace')
  assert.strictEqual(n.normalize({ level: 30 }).levelName, 'info')
  assert.strictEqual(n.normalize({ level: 60 }).levelName, 'fatal')
  const unknown = n.normalize({ level: 35 })
  assert.strictEqual(unknown.levelName, 'level:35')
  assert.strictEqual(unknown.levelKnown, false)
})

test('custom level tables are honoured', () => {
  const custom = createNormalizer({ levels: { notice: 35, audit: 65 } })
  assert.strictEqual(custom.normalize({ level: 35 }).levelName, 'notice')
  assert.strictEqual(custom.normalize({ level: 65 }).levelName, 'audit')
  // Defaults stay reachable alongside custom levels.
  assert.strictEqual(custom.normalize({ level: 30 }).levelName, 'info')
})

test('string levels (formatters.level) resolve by name and by digit', () => {
  assert.deepStrictEqual(n.normalize({ level: 'warn' }).levelNum, 40)
  assert.strictEqual(n.normalize({ level: 'warn' }).levelName, 'warn')
  assert.strictEqual(n.normalize({ level: '50' }).levelName, 'error')
  assert.strictEqual(n.normalize({ level: 'custom-thing' }).levelName, 'custom-thing')
})

test('time accepts epoch ms, epoch s, nanoseconds and ISO strings', () => {
  assert.strictEqual(n.normalize({ time: 1792690000000 }).timeMs, 1792690000000)
  assert.strictEqual(n.normalize({ time: 1792690000000 }).timeUnit, 'ms')
  const seconds = n.normalize({ time: 1792690000 })
  assert.strictEqual(seconds.timeMs, 1792690000000)
  assert.strictEqual(seconds.timeUnit, 's')
  assert.strictEqual(seconds.timeCoerced, true)
  const iso = n.normalize({ time: '2026-10-22T18:35:36.641Z' })
  assert.strictEqual(iso.timeMs, Date.parse('2026-10-22T18:35:36.641Z'))
  assert.strictEqual(n.normalize({}).timeMs, null)
  assert.strictEqual(n.normalize({ time: 'not a date' }).timeMs, null)
})

test('messages keep type information', () => {
  assert.deepStrictEqual(n.resolveMessage('hi'), { text: 'hi', isObject: false })
  assert.deepStrictEqual(n.resolveMessage(0), { text: '0', isObject: false })
  assert.strictEqual(n.resolveMessage({ a: 1 }).isObject, true)
  assert.strictEqual(n.resolveMessage(undefined).text, '')
})

test('errors accept pino objects and bare strings', () => {
  const obj = n.resolveError({ type: 'TypeError', message: 'bad', stack: 'TypeError: bad\n  at x', code: 'E1' })
  assert.strictEqual(obj.type, 'TypeError')
  assert.strictEqual(obj.code, 'E1')
  const str = n.resolveError('plain failure')
  assert.strictEqual(str.message, 'plain failure')
  assert.strictEqual(n.resolveError(undefined), null)
})

test('duration is taken from the first recognised latency field', () => {
  assert.strictEqual(n.normalize({ responseTime: 12.5 }).durMs, 12.5)
  assert.strictEqual(n.normalize({ duration: '7' }).durMs, 7)
  assert.strictEqual(n.normalize({ latency: 3 }).durMs, 3)
  assert.strictEqual(n.normalize({ responseTime: 'n/a' }).durMs, null)
  assert.strictEqual(n.normalize({ responseTime: -1 }).durMs, null)
  assert.strictEqual(n.normalize({}).durMs, null)
})

test('redaction markers are detected at depth', () => {
  assert.strictEqual(n.normalize({ a: { b: { c: REDACTED_MARKERS[0] } } }).redacted, true)
  assert.strictEqual(n.normalize({ a: [REDACTED_MARKERS[0]] }).redacted, true)
  assert.strictEqual(n.normalize({ a: 'visible' }).redacted, false)
})

test('dotted key paths support pino nestedKey layouts', () => {
  const nested = createNormalizer({ msgKey: 'payload.msg', errKey: 'payload.err' })
  const entry = nested.normalize({ level: 50, payload: { msg: 'inside', err: { message: 'deep' } } })
  assert.strictEqual(entry.msg, 'inside')
  assert.strictEqual(entry.err.message, 'deep')
})

test('getPath tolerates missing intermediate objects', () => {
  assert.strictEqual(n.getPath({}, 'a.b.c'), undefined)
  assert.strictEqual(n.getPath({ a: null }, 'a.b'), undefined)
  assert.strictEqual(n.getPath({ a: { b: 2 } }, 'a.b'), 2)
  assert.strictEqual(n.getPath({ a: 1 }, 'a'), 1)
})
