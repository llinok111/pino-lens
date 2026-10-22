#!/usr/bin/env node
'use strict'
/**
 * pino-lens CLI — build a self-contained report from pino NDJSON files.
 * MIT License. See lens/LICENSE.
 *
 *   pino-lens build app.log -o report.html
 *   pino-lens stats app.log --query 'level>=warn'
 *   pino-lens verify app.log          # exit 2 when lines are unparsable
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const lens = require('../src/index')
const lensPkg = require('../package.json')

const SCRIPT_ORDER = [
  'src/core/levels.js',
  'src/core/ndjson.js',
  'src/core/normalize.js',
  'src/core/store.js',
  'src/core/query.js',
  'src/core/aggregate.js',
  'src/core/exporter.js',
  'src/ui/format.js',
  'src/ui/table.js',
  'src/ui/timeline.js',
  'src/ui/detail.js',
  'src/ui/app.js'
]

const LENS_ROOT = path.resolve(__dirname, '..')
const TEMPLATE = path.join(LENS_ROOT, 'assets', 'report-template.html')
const EMBED_WARN_BYTES = 24 * 1024 * 1024

function usage () {
  return [
    'pino-lens ' + lensPkg.version + ' — interactive explorer for pino NDJSON logs',
    '',
    'Usage:',
    '  pino-lens build <file...> [-o out.html] [--title NAME] [--limit N] [--split]',
    '  pino-lens stats <file...> [--query QUERY] [--sort KEY] [--dir asc|desc]',
    '  pino-lens verify <file...>',
    '',
    'Options:',
    '  -o, --out <file>   output html path (default: pino-lens-report.html)',
    '  --title <name>     report title shown in the header',
    '  --limit <n>        stop after n valid entries (useful for huge files)',
    '  --split            keep data in a sibling .ndjson file (needs an http server)',
    '  --query <query>    pre-filter the report / stats with the lens query language',
    '  --levels a=35,b=70 declare pino customLevels so numeric levels render as names',
    '  --msg-key K        message field name/path (default msg; nestedKey: payload.msg)',
    '  --err-key K        error field name/path (default err)',
    '  --level-key K      level field (default level)',
    '  --time-key K       timestamp field (default time)',
    '  --json             (stats) print machine readable JSON only',
    ''
  ].join('\n')
}

function parseArgs (argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-o' || arg === '--out') out.out = argv[++i]
    else if (arg === '--title') out.title = argv[++i]
    else if (arg === '--limit') out.limit = Number(argv[++i])
    else if (arg === '--query') out.query = argv[++i]
    else if (arg === '--levels') out.levels = argv[++i]
    else if (arg === '--msg-key') out.msgKey = argv[++i]
    else if (arg === '--err-key') out.errKey = argv[++i]
    else if (arg === '--level-key') out.levelKey = argv[++i]
    else if (arg === '--time-key') out.timeKey = argv[++i]
    else if (arg === '--sort') out.sort = argv[++i]
    else if (arg === '--dir') out.dir = argv[++i]
    else if (arg === '--split') out.split = true
    else if (arg === '--json') out.json = true
    else if (arg === '-h' || arg === '--help') out.help = true
    else out._.push(arg)
  }
  return out
}

function readSources (files) {
  if (!files.length) fail('no input file given\n\n' + usage())
  const chunks = []
  const sources = []
  for (const file of files) {
    const resolved = path.resolve(file)
    if (!fs.existsSync(resolved)) fail('input file not found: ' + file)
    const text = fs.readFileSync(resolved, 'utf8')
    sources.push({
      path: path.basename(resolved),
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex')
    })
    chunks.push(text.endsWith('\n') ? text : text + '\n')
  }
  return { text: chunks.join(''), sources }
}

function pinoVersion () {
  try {
    return require(path.resolve(LENS_ROOT, '..', 'package.json')).version
  } catch (err) {
    return null
  }
}

function keyOverrides (args) {
  const keys = {}
  if (args.msgKey) keys.msgKey = args.msgKey
  if (args.errKey) keys.errKey = args.errKey
  if (args.levelKey) keys.levelKey = args.levelKey
  if (args.timeKey) keys.timeKey = args.timeKey
  return keys
}

function parseLevels (spec) {
  if (!spec) return null
  const table = {}
  for (const pair of String(spec).split(',')) {
    const [name, value] = pair.split('=')
    if (!name || value === undefined) fail('bad --levels entry "' + pair + '" (expected name=number)')
    const num = Number(value)
    if (!Number.isFinite(num)) fail('bad level number in "' + pair + '"')
    table[name.trim()] = num
  }
  return table
}

function escapeForScript (json) {
  // Prevent an embedded `</script>` (log messages can contain anything) and
  // the JSON-in-HTML separators that some engines treat as newlines.
  return json
    .replace(/<\//g, '<\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function build (args) {
  const { text, sources } = readSources(args._)
  const started = Date.now()
  const levels = parseLevels(args.levels)
  const keys = keyOverrides(args)
  const store = lens.buildStore(text, Object.assign({ maxEntries: args.limit || 0, levels }, keys))
  const buildMs = Date.now() - started
  if (store.count === 0) fail('no valid pino entries found in ' + args._.join(', '))

  const meta = {
    title: args.title || path.basename(args._[0]),
    generatedAt: new Date().toISOString(),
    lensVersion: lensPkg.version,
    pinoVersion: pinoVersion(),
    levels,
    keys: Object.keys(keys).length ? keys : null,
    sources,
    limit: args.limit || null,
    query: args.query || '',
    entries: store.count,
    bytes: store.bytes,
    issues: {
      invalidJson: store.issues.invalidJson,
      notAnObject: store.issues.notAnObject,
      emptyLines: store.issues.emptyLines,
      oversizedLines: store.issues.oversizedLines
    }
  }

  const template = fs.readFileSync(TEMPLATE, 'utf8')
  const css = fs.readFileSync(path.join(LENS_ROOT, 'src/ui/styles.css'), 'utf8')
  const scripts = SCRIPT_ORDER
    .map(rel => '// ---- ' + rel + ' ----\n' + fs.readFileSync(path.join(LENS_ROOT, rel), 'utf8'))
    .join('\n')

  const outPath = path.resolve(args.out || 'pino-lens-report.html')
  const payload = escapeForScript(JSON.stringify({ meta, ndjson: text }))
  let dataBlock = payload
  let extraFile = null
  if (args.split) {
    const dataPath = outPath.replace(/\.html?$/i, '') + '.ndjson'
    fs.writeFileSync(dataPath, text)
    extraFile = dataPath
    dataBlock = ''
  }

  let html = template
    .replace(/__PINOLENS_TITLE__/g, escapeHtml(meta.title) + ' · pino-lens')
    .replace('/*__PINOLENS_CSS__*/', () => css)
    .replace('/*__PINOLENS_SCRIPTS__*/', () => scripts)
    .replace('__PINOLENS_VERSION__', lensPkg.version)
    .replace('__PINOLENS_DATA__', () => dataBlock)

  if (args.split) {
    html = html.replace('id="pino-lens-data" type="application/json"', 'id="pino-lens-data" type="application/json" data-src="' + path.basename(extraFile) + '"')
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, html)

  const htmlBytes = Buffer.byteLength(html, 'utf8')
  process.stdout.write([
    'pino-lens ' + lensPkg.version,
    '  entries   ' + store.count.toLocaleString('en-US') + '  (' + store.issues.totalLines.toLocaleString('en-US') + ' lines read)',
    '  parse     ' + (store.issues.invalidJson + store.issues.notAnObject + store.issues.emptyLines) + ' skipped line(s)',
    '  build     ' + buildMs + ' ms',
    '  report    ' + outPath + '  (' + (htmlBytes / 1024).toFixed(0) + ' KB)' + (extraFile ? '\n  data      ' + extraFile : ''),
    args.limit && store.issues.skippedByLimit ? '  limit     ' + store.issues.skippedByLimit + ' line(s) not embedded' : ''
  ].filter(Boolean).join('\n') + '\n')

  if (htmlBytes > EMBED_WARN_BYTES) {
    process.stderr.write('warning: embedded report is larger than 24 MB; browsers may struggle. Consider --split or --limit.\n')
  }
}

function stats (args) {
  const { text, sources } = readSources(args._)
  const started = Date.now()
  const result = lens.analyze(text, {
    query: args.query || '',
    sort: { key: args.sort || 'time', dir: args.dir || 'asc' },
    levels: parseLevels(args.levels),
    ...keyOverrides(args)
  })
  const elapsed = Date.now() - started
  const payload = {
    tool: 'pino-lens',
    version: lensPkg.version,
    sources,
    entries: result.store.count,
    lines: result.store.issues.totalLines,
    issues: result.store.issues,
    matched: result.summary.count,
    query: args.query || '',
    summary: result.summary,
    elapsedMs: elapsed
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    return
  }
  const lines = []
  lines.push('entries      ' + payload.entries + ' / ' + payload.lines + ' lines')
  lines.push('matched      ' + payload.matched)
  if (payload.issues.invalidJson || payload.issues.notAnObject) {
    lines.push('skipped      ' + payload.issues.invalidJson + ' invalid, ' + payload.issues.notAnObject + ' non-object')
  }
  lines.push('levels       ' + result.summary.byLevel.map(l => l.name + '=' + l.count).join(' '))
  if (result.summary.duration) {
    const d = result.summary.duration
    lines.push('latency ms   p50 ' + d.p50.toFixed(1) + '  p95 ' + d.p95.toFixed(1) + '  p99 ' + d.p99.toFixed(1) + '  max ' + d.max.toFixed(1))
  }
  lines.push('elapsed      ' + elapsed + ' ms')
  process.stdout.write(lines.join('\n') + '\n')
}

function verify (args) {
  const { text, sources } = readSources(args._)
  const scan = lens.scan(text)
  const bad = scan.issues.invalidJson + scan.issues.notAnObject
  process.stdout.write(JSON.stringify({ files: sources, lines: scan.issues.totalLines, valid: scan.valid, issues: scan.issues }, null, 2) + '\n')
  if (bad > 0) process.exitCode = 2
}

function escapeHtml (str) {
  return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

function fail (message) {
  process.stderr.write('pino-lens: ' + message + '\n')
  process.exit(1)
}

function main () {
  const argv = process.argv.slice(2)
  const first = argv[0]
  const command = first && first.startsWith('-') ? null : argv.shift()
  const args = parseArgs(argv)
  if (!command || args.help) {
    process.stdout.write(usage())
    return
  }
  if (command === 'build') return build(args)
  if (command === 'stats') return stats(args)
  if (command === 'verify') return verify(args)
  fail('unknown command "' + command + '"\n\n' + usage())
}

main()
