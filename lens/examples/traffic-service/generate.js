'use strict'
/**
 * pino-lens example — generate a real NDJSON log dataset.
 *
 * Nothing here is fabricated: the file is written by pino itself while a real
 * HTTP server answers real requests over the loopback interface. The manifest
 * records the exact command, versions, counts and per-file hashes so the sample
 * can be reproduced and checked.
 *
 *   node generate.js --requests 30000 --out data/traffic.ndjson
 *   node generate.js --requests 120000 --out data/stress.ndjson --concurrency 32
 *
 * MIT License. See lens/LICENSE.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const pino = require('../../../pino.js')
const { createService } = require('./server')
const { drive } = require('./driver')

function parseArgs (argv) {
  const out = { requests: 30000, out: 'data/traffic.ndjson', concurrency: 24, seed: 20261023 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--requests') out.requests = Number(argv[++i])
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--concurrency') out.concurrency = Number(argv[++i])
    else if (a === '--seed') out.seed = Number(argv[++i])
  }
  return out
}

function gitCommit () {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8' }).trim()
  } catch (err) {
    return null
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const outPath = path.resolve(__dirname, args.out)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath)

  const destination = pino.destination({ dest: outPath, sync: false, mkdir: true })
  const { server } = createService({ destination, hostname: 'lab-node-01' })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  process.stdout.write('generating ' + args.requests + ' requests against 127.0.0.1:' + port + '\n')
  const stats = await drive({
    port,
    requests: args.requests,
    concurrency: args.concurrency,
    seed: args.seed,
    onProgress: (done, total) => process.stdout.write('  ' + done + '/' + total + '\n')
  })
  const elapsedMs = Date.now() - t0

  await new Promise((resolve) => server.close(resolve))
  destination.flushSync()
  const closed = new Promise((resolve) => destination.on('close', resolve))
  destination.end()
  await closed

  const text = fs.readFileSync(outPath, 'utf8')
  const lines = text.split('\n').filter(Boolean)
  const bytes = Buffer.byteLength(text, 'utf8')
  const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex')

  const manifest = {
    tool: 'pino-lens/example-traffic-service',
    generatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: elapsedMs,
    command: 'node generate.js ' + process.argv.slice(2).join(' '),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      pino: require('../../../package.json').version,
      pinoCommit: gitCommit(),
      source: 'repository build at ../../../pino.js'
    },
    requestMix: {
      requests: args.requests,
      concurrency: args.concurrency,
      seed: args.seed,
      ok: stats.ok,
      client4xx: stats.client4xx,
      server5xx: stats.server5xx,
      networkErrors: stats.networkError
    },
    output: {
      file: path.basename(outPath),
      lines: lines.length,
      bytes,
      sha256,
      linesPerRequest: Number((lines.length / args.requests).toFixed(3))
    },
    privacy: 'No personal data: hostname is a fixed base binding ("lab-node-01"), the bearer token sent by the driver is the literal string "demo-token-not-a-secret" and is redacted by pino before it reaches the file.'
  }

  fs.writeFileSync(outPath.replace(/\.ndjson$/, '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  process.stdout.write([
    'done in ' + (elapsedMs / 1000).toFixed(1) + ' s',
    '  lines  ' + lines.length,
    '  bytes  ' + bytes,
    '  sha256 ' + sha256.slice(0, 16) + '…',
    '  out    ' + outPath
  ].join('\n') + '\n')
}

main().catch((err) => {
  process.stderr.write('generation failed: ' + (err && err.stack ? err.stack : err) + '\n')
  process.exit(1)
})
