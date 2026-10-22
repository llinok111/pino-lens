'use strict'
const test = require('node:test')
const assert = require('node:assert')

const { buildStore } = require('../src/core/store')
const { parseQuery, filterStore, sortIndices, combine, stringifyQuery, tokenize } = require('../src/core/query')

const T0 = 1792690000000
const TEXT = [
  { level: 10, time: T0, msg: 'trace alpha', host: 'a', n: 1 },
  { level: 30, time: T0 + 1000, msg: 'info beta', host: 'b', n: 2, responseTime: 12 },
  { level: 40, time: T0 + 2000, msg: 'warn Gamma timeout', host: 'a', n: 3, responseTime: 250 },
  { level: 50, time: T0 + 3000, msg: 'error delta', host: 'c', n: 4, responseTime: 900, err: { message: 'x' } },
  { level: 60, time: T0 + 4000, msg: 'fatal epsilon', host: 'a' }
].map(o => JSON.stringify(o)).join('\n') + '\n'

const store = buildStore(TEXT)

function count (queryText) {
  return filterStore(store, parseQuery(queryText)).length
}

test('bare terms search the message, case-insensitively', () => {
  assert.strictEqual(count('gamma'), 1)
  assert.strictEqual(count('GAMMA'), 1)
  assert.strictEqual(count('nothing-matches'), 0)
})

test('quoted phrases and negation work', () => {
  assert.strictEqual(count('msg~"gamma timeout"'), 1)
  assert.strictEqual(count('-gamma'), 4)
  assert.strictEqual(count('host=a -gamma'), 2)
})

test('level comparisons use numeric levels', () => {
  assert.strictEqual(count('level>=warn'), 3)
  assert.strictEqual(count('level>=40'), 3)
  assert.strictEqual(count('level>warn'), 2)
  assert.strictEqual(count('level<info'), 1)
  assert.strictEqual(count('level=error,fatal'), 2)
  assert.strictEqual(count('level!=info'), 4)
})

test('time windows accept ISO strings and epoch milliseconds', () => {
  assert.strictEqual(count('time>=' + new Date(T0 + 2000).toISOString()), 3)
  assert.strictEqual(count('time<' + new Date(T0 + 2000).toISOString()), 2)
  assert.strictEqual(count('time>=' + (T0 + 1000) + ' time<=' + (T0 + 3000)), 3)
})

test('field predicates cover equality, substring, numeric and existence', () => {
  assert.strictEqual(count('host=a'), 3)
  assert.strictEqual(count('host!=a'), 2)
  assert.strictEqual(count('host~a'), 3)
  assert.strictEqual(count('n>2'), 2, 'the fatal entry carries no n field')
  assert.strictEqual(count('n<=2'), 2)
  assert.strictEqual(count('err exists'), 1)
  assert.strictEqual(count('host exists'), 5)
})

test('duration alias maps to the latency column', () => {
  assert.strictEqual(count('duration>100'), 2)
  assert.strictEqual(count('dur>=250'), 2)
  assert.strictEqual(count('latency<100'), 1)
})

test('invalid tokens become reported errors, never silent widening', () => {
  const bad = parseQuery('level>bogus')
  assert.strictEqual(bad.errors.length, 1)
  assert.match(bad.errors[0].message, /unknown level/)

  const badOp = parseQuery('level~info')
  assert.strictEqual(badOp.errors.length, 1)

  const badTime = parseQuery('time>=yesterday-ish')
  assert.strictEqual(badTime.errors.length, 1)

  const missingValue = parseQuery('host=')
  assert.strictEqual(missingValue.errors.length, 1)

  // An invalid query still filters on what it could parse (nothing here).
  assert.strictEqual(filterStore(store, bad).length, 5)
})

test('tokenizer respects quotes and negation', () => {
  const tokens = tokenize('a "b c" -d level>=warn')
  assert.deepStrictEqual(tokens.map(t => t.text), ['a', 'b c', 'd', 'level>=warn'])
  assert.strictEqual(tokens[2].negate, true)
})

test('sorting handles missing values deterministically', () => {
  const asc = sortIndices(store, filterStore(store, parseQuery('')), 'duration', 'asc')
  assert.deepStrictEqual(Array.from(asc).map(i => store.dur[i]).filter(Number.isFinite), [12, 250, 900])
  assert.ok(Number.isNaN(store.dur[asc[3]]), 'NaN rows are pushed last in ascending order')

  const desc = sortIndices(store, filterStore(store, parseQuery('')), 'duration', 'desc')
  assert.strictEqual(store.dur[desc[0]], 900)
  assert.ok(Number.isNaN(store.dur[desc[4]]), 'NaN rows stay last in descending order too')
})

test('time sort is stable for identical timestamps', () => {
  const tied = buildStore([
    JSON.stringify({ level: 30, time: T0, msg: 'first' }),
    JSON.stringify({ level: 30, time: T0, msg: 'second' }),
    JSON.stringify({ level: 30, time: T0, msg: 'third' })
  ].join('\n'))
  const sorted = sortIndices(tied, filterStore(tied, parseQuery('')), 'time', 'asc')
  assert.deepStrictEqual(Array.from(sorted), [0, 1, 2])
})

test('combine narrows but never widens', () => {
  const base = parseQuery('level>=warn')
  const narrowed = combine(base, { levels: ['warn', 'fatal'] })
  assert.strictEqual(filterStore(store, narrowed).length, 2)

  const cleared = combine(base, { levels: null })
  assert.strictEqual(filterStore(store, cleared).length, 3)

  const ranged = combine(parseQuery('time>=' + (T0 + 1000)), { from: T0 + 3000, to: T0 + 3500 })
  const hits = filterStore(store, ranged)
  assert.strictEqual(hits.length, 1)
  assert.strictEqual(store.time[hits[0]], T0 + 3000)
})

test('stringifyQuery round-trips to the same result set', () => {
  for (const query of ['level>=warn', 'host=a -gamma', 'duration>100', 'msg~"gamma timeout"', 'err exists']) {
    const parsed = parseQuery(query)
    const round = parseQuery(stringifyQuery(parsed))
    assert.strictEqual(filterStore(store, round).length, filterStore(store, parsed).length, 'round-trip: ' + query)
  }
})
