'use strict'
const test = require('node:test')
const assert = require('node:assert')

const { splitLines, parseLine, scan } = require('../src/core/ndjson')

test('splitLines handles LF, CRLF, BOM and trailing newline', () => {
  const a = splitLines('a\nb\n')
  assert.deepStrictEqual(a.lines, ['a', 'b'])
  assert.strictEqual(a.trailingNewline, true)
  assert.strictEqual(a.hadBom, false)

  const b = splitLines('\uFEFF{"x":1}\r\n{"y":2}\r\n')
  assert.deepStrictEqual(b.lines, ['{"x":1}', '{"y":2}'])
  assert.strictEqual(b.hadBom, true)

  const c = splitLines('only-line')
  assert.deepStrictEqual(c.lines, ['only-line'])
  assert.strictEqual(c.trailingNewline, false)
})

test('splitLines keeps interior blank lines so they can be reported', () => {
  const { lines } = splitLines('a\n\nb\n')
  assert.deepStrictEqual(lines, ['a', '', 'b'])
})

test('parseLine reports invalid JSON without throwing', () => {
  const res = parseLine('{"level":30,', 9)
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.code, 'invalid-json')
  assert.strictEqual(res.lineNo, 9)
  assert.ok(res.message.length > 0)
})

test('parseLine rejects valid JSON that is not an object', () => {
  assert.strictEqual(parseLine('[1,2]', 1).code, 'not-an-object')
  assert.strictEqual(parseLine('"text"', 1).code, 'not-an-object')
  assert.strictEqual(parseLine('null', 1).code, 'not-an-object')
  assert.strictEqual(parseLine('', 1).code, 'empty')
})

test('parseLine truncates long snippets', () => {
  const long = '{"a":"' + 'x'.repeat(400) + '"'
  const res = parseLine(long, 1)
  assert.strictEqual(res.ok, false)
  assert.ok(res.snippet.length <= 161, 'snippet should be capped')
})

test('scan counts every failure class and keeps samples', () => {
  const text = '\uFEFF{"level":30,"msg":"ok"}\r\n\r\n[1,2]\r\n{"level":30,\r\n'
  const res = scan(text)
  assert.strictEqual(res.valid, 1)
  assert.strictEqual(res.issues.emptyLines, 1)
  assert.strictEqual(res.issues.notAnObject, 1)
  assert.strictEqual(res.issues.invalidJson, 1)
  assert.strictEqual(res.issues.hadBom, true)
  assert.strictEqual(res.issues.samples.length, 3)
})
