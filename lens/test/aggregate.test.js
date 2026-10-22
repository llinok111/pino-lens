'use strict'
const test = require('node:test')
const assert = require('node:assert')

const { buildStore } = require('../src/core/store')
const { parseQuery, filterStore } = require('../src/core/query')
const { summarize, templateOf, niceStep, percentile } = require('../src/core/aggregate')

const T0 = 1792690000000
const lines = []
for (let i = 0; i < 100; i++) {
  const level = i % 10 === 0 ? 50 : i % 3 === 0 ? 40 : 30
  lines.push(JSON.stringify({
    level,
    time: T0 + i * 100,
    msg: 'request ' + i + ' handled',
    responseTime: i,
    ...(level === 50 ? { err: { message: 'boom' } } : {})
  }))
}
lines.push(JSON.stringify({ level: 30, msg: 'no timestamp here' }))
const store = buildStore(lines.join('\n') + '\n')

test('summarize counts levels, errors and the span', () => {
  const all = filterStore(store, parseQuery(''))
  const s = summarize(store, all)
  assert.strictEqual(s.count, 101)
  assert.strictEqual(s.totalInStore, 101)
  const byLevel = Object.fromEntries(s.byLevel.map(l => [l.name, l.count]))
  assert.strictEqual(byLevel.info, 61, '60 timed info lines plus the untimed one')
  assert.strictEqual(byLevel.warn, 30, 'i%3===0 minus the three that are also i%10===0')
  assert.strictEqual(byLevel.error, 10)
  assert.strictEqual(s.flags.hasError, 10)
  assert.strictEqual(s.flags.timeMissing, 1)
  assert.strictEqual(s.span.from, T0)
  assert.strictEqual(s.span.to, T0 + 9900)
  assert.ok(Math.abs(s.errorRate - 10 / 101) < 1e-12)
})

test('buckets only cover timed entries and sum to their count', () => {
  const all = filterStore(store, parseQuery(''))
  const s = summarize(store, all)
  const total = s.buckets.reduce((acc, b) => acc + b.total, 0)
  assert.strictEqual(total, 100)
  assert.ok(s.buckets.length <= 200, 'bucket count is capped')
  const levelSum = s.buckets.reduce((acc, b) => acc + Object.values(b.levels).reduce((x, y) => x + y, 0), 0)
  assert.strictEqual(levelSum, 100)
})

test('latency percentiles use nearest rank over finite values', () => {
  const all = filterStore(store, parseQuery(''))
  const s = summarize(store, all)
  assert.strictEqual(s.duration.samples, 100)
  assert.strictEqual(s.duration.min, 0)
  assert.strictEqual(s.duration.max, 99)
  assert.strictEqual(s.duration.p50, 49)
  assert.strictEqual(percentile([1, 2, 3, 4], 50), 2)
  assert.strictEqual(percentile([], 50), null)
})

test('message templates collapse ids and numbers', () => {
  assert.strictEqual(templateOf('request 42 handled'), 'request # handled')
  assert.strictEqual(templateOf('user 8f4b2c9d-1111-4222-8333-944455556666 logged in'), 'user <uuid> logged in')
  assert.strictEqual(templateOf('at 2026-10-22T18:35:36.641Z done'), 'at <ts> done')
  const s = summarize(store, filterStore(store, parseQuery('')))
  assert.strictEqual(s.topMessages[0].count, 100)
  assert.match(s.topMessages[0].template, /^request # handled$/)
})

test('summarize survives an empty selection', () => {
  const s = summarize(store, filterStore(store, parseQuery('nothing-matches')))
  assert.strictEqual(s.count, 0)
  assert.deepStrictEqual(s.byLevel, [])
  assert.strictEqual(s.duration, null)
  assert.deepStrictEqual(s.buckets, [])
  assert.strictEqual(s.errorRate, 0)
})

test('niceStep produces 1/2/5 steps', () => {
  assert.strictEqual(niceStep(1), 1)
  assert.strictEqual(niceStep(1.4), 2)
  assert.strictEqual(niceStep(3), 5)
  assert.strictEqual(niceStep(8), 10)
  assert.strictEqual(niceStep(230), 500)
})
