'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { buildFixtures } = require('./fixtures')

const CLI = path.resolve(__dirname, '..', 'bin', 'pino-lens.js')
const fixtures = buildFixtures()
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pino-lens-cli-'))

function run (args, options) {
  try {
    const stdout = execFileSync(process.execPath, [CLI].concat(args), { encoding: 'utf8', cwd: outDir, ...options })
    return { status: 0, stdout }
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') }
  }
}

test('build writes a self-contained report with embedded data', () => {
  const out = path.join(outDir, 'report.html')
  const res = run(['build', fixtures.files.default, '-o', out, '--title', 'fixture report'])
  assert.strictEqual(res.status, 0, res.stderr)
  const html = fs.readFileSync(out, 'utf8')
  assert.ok(html.includes('fixture report · pino-lens'), 'title is escaped into <title>')
  assert.ok(html.includes('id="pino-lens-data"'), 'data block present')
  assert.ok(html.includes('pino-lens ' + require('../package.json').version))
  assert.ok(html.includes('createTable'), 'UI scripts inlined')

  const match = /<script id="pino-lens-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(match, 'data block is delimited')
  const payload = JSON.parse(match[1])
  assert.strictEqual(payload.meta.entries, 4)
  assert.strictEqual(typeof payload.ndjson, 'string')
  assert.strictEqual(payload.meta.pinoVersion, require('../../package.json').version)
})

test('embedded data cannot break out of the script tag', () => {
  const out = path.join(outDir, 'xss.html')
  const res = run(['build', fixtures.files.xss, '-o', out])
  assert.strictEqual(res.status, 0, res.stderr)
  const html = fs.readFileSync(out, 'utf8')
  const start = html.indexOf('<script id="pino-lens-data"')
  const end = html.indexOf('</script>', start)
  const block = html.slice(start, end)
  assert.ok(!block.includes('</script'), 'no premature close tag inside the data block')
  assert.ok(block.includes('<\\/script>'), 'escaped form is used')

  const dataBlock = /type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]
  const payload = JSON.parse(dataBlock.replace(/\\\//g, '/'))
  assert.strictEqual(payload.ndjson.includes('</script><img'), true)
})

test('build honours --limit and reports skipped lines', () => {
  const out = path.join(outDir, 'limited.html')
  const res = run(['build', fixtures.files.default, '-o', out, '--limit', '2'])
  assert.strictEqual(res.status, 0, res.stderr)
  assert.match(res.stdout, /limit\s+2 line\(s\) not embedded/)
})

test('stats --json matches the analyzer output', () => {
  const res = run(['stats', fixtures.files.default, '--json'])
  assert.strictEqual(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.strictEqual(payload.entries, 4)
  assert.strictEqual(payload.matched, 4)
  assert.deepStrictEqual(payload.sources.map(s => s.path), ['default.ndjson'])
  assert.match(payload.sources[0].sha256, /^[0-9a-f]{64}$/)
})

test('stats accepts custom levels and applies queries', () => {
  const res = run(['stats', fixtures.files.customLevels, '--json', '--levels', 'notice=35,audit=65', '--query', 'level>=notice'])
  assert.strictEqual(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  const names = payload.summary.byLevel.map(l => l.name).sort()
  assert.deepStrictEqual(names, ['audit', 'notice'])
})

test('nestedKey files need an err-key override to see serialised errors', () => {
  const plain = JSON.parse(run(['stats', fixtures.files.nested, '--json']).stdout)
  assert.strictEqual(plain.matched, 3)
  assert.strictEqual(plain.summary.topMessages.length, 3, 'msg stays top level under nestedKey')
  assert.strictEqual(plain.summary.flags.hasError, 0, 'err moved under payload, so it is not detected')

  const mapped = JSON.parse(run(['stats', fixtures.files.nested, '--json', '--err-key', 'payload.err']).stdout)
  assert.strictEqual(mapped.summary.flags.hasError, 1)
  assert.strictEqual(mapped.summary.flags.redacted, 1)
})

test('verify exits with code 2 when a line cannot be parsed', () => {
  const res = run(['verify', fixtures.files.damaged])
  assert.strictEqual(res.status, 2)
  const payload = JSON.parse(res.stdout)
  assert.strictEqual(payload.valid, 2)
  assert.strictEqual(payload.issues.invalidJson, 1)
  assert.strictEqual(payload.issues.notAnObject, 1)
  assert.strictEqual(payload.issues.emptyLines, 2)
})

test('verify exits 0 on a clean file', () => {
  const res = run(['verify', fixtures.files.default])
  assert.strictEqual(res.status, 0)
  assert.strictEqual(JSON.parse(res.stdout).valid, 4)
})

test('a missing input file fails loudly', () => {
  const res = run(['stats', path.join(outDir, 'nope.ndjson')])
  assert.strictEqual(res.status, 1)
  assert.match(res.stderr, /input file not found/)
})
