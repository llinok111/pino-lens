'use strict'
/**
 * Test fixtures built with the real pino from this repository.
 *
 * Every fixture here is written by pino itself so the tests exercise the
 * actual wire format, including the awkward corners: string levels from a
 * custom formatter, ISO timestamps, a renamed message key, nested keys,
 * redaction censors, serialised errors and circular structures.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const pino = require('../../pino.js')

function tmpDir (prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'pino-lens-') + '-'))
  return dir
}

function writeWith (file, options, emit) {
  const destination = pino.destination({ dest: file, sync: true })
  const logger = pino(options, destination)
  emit(logger)
  destination.flushSync()
  destination.end()
  return fs.readFileSync(file, 'utf8')
}

/**
 * Produce a set of real log files used across the test suite.
 * @returns {{dir: string, files: Record<string, string>, texts: Record<string, string>}}
 */
function buildFixtures () {
  const dir = tmpDir()
  const files = {}
  const texts = {}

  // 1. Defaults: numeric levels, epoch ms, base pid/hostname.
  files.default = path.join(dir, 'default.ndjson')
  texts.default = writeWith(files.default, { base: { pid: 4242, hostname: 'fixture-host' } }, (log) => {
    log.trace('trace line')
    log.debug('debug line')
    log.info('info line %d', 7)
    log.warn({ responseTime: 12.5 }, 'warn line')
    log.error({ err: new Error('kaboom') }, 'error line')
    log.fatal('fatal line')
  })

  // 2. Custom levels + ISO timestamps.
  files.customLevels = path.join(dir, 'custom-levels.ndjson')
  texts.customLevels = writeWith(files.customLevels, {
    base: { hostname: 'fixture-host' },
    customLevels: { notice: 35, audit: 65 },
    level: 'trace',
    timestamp: pino.stdTimeFunctions.isoTime
  }, (log) => {
    log.notice('notice line')
    log.audit('audit line')
    log.info('info line')
  })

  // 3. Level formatter writes a label string; message key renamed.
  files.stringLevel = path.join(dir, 'string-level.ndjson')
  texts.stringLevel = writeWith(files.stringLevel, {
    base: { hostname: 'fixture-host' },
    messageKey: 'message',
    formatters: {
      level (label) { return { level: label } }
    }
  }, (log) => {
    log.info('string level info')
    log.warn({ code: 'W1' }, 'string level warn')
  })

  // 4. Nested key, redaction, error objects, arrays, unicode.
  files.nested = path.join(dir, 'nested.ndjson')
  texts.nested = writeWith(files.nested, {
    base: { hostname: 'fixture-host' },
    nestedKey: 'payload',
    // With nestedKey, redaction runs on the object *before* it is nested, so
    // paths are relative to the log object (verified against pino v10.4.0).
    redact: { paths: ['password', 'headers.authorization'], censor: '[Redacted]' }
  }, (log) => {
    log.info({ password: 'hunter2', headers: { authorization: 'Bearer abc' }, tags: ['a', 'b'], deep: { a: { b: { c: 1 } } } }, 'nested payload')
    log.info({ name: '成都 · São Paulo 👋' }, 'unicode message 你好')
    log.error({ err: Object.assign(new Error('with code'), { code: 'E_FIXTURE' }) }, 'coded error')
  })

  // 5. Deliberately damaged file: BOM + CRLF + blank lines + truncation + non-object.
  files.damaged = path.join(dir, 'damaged.ndjson')
  const good = '{"level":30,"time":1792690000000,"msg":"ok"}'
  const crlf = good + '\r\n'
  texts.damaged = '\uFEFF' + crlf + '\r\n' + '   ' + '\r\n' + '[1,2,3]\r\n' + '{"level":30,"time":1792690000001,"msg":"second"}\r\n' + '{"level":30,"time":17926900'
  fs.writeFileSync(files.damaged, texts.damaged, 'utf8')

  // 6. Circular reference + non-finite numbers + undefined/function fields.
  files.circular = path.join(dir, 'circular.ndjson')
  texts.circular = writeWith(files.circular, { base: { hostname: 'fixture-host' } }, (log) => {
    const cycle = { name: 'root' }
    cycle.self = cycle
    log.info({ cycle, bad: NaN, alsoBad: Infinity, skipped: undefined, fn () {}, ok: true }, 'weird values')
  })

  // 7. Message that looks like a closing script tag (HTML embedding risk).
  files.xss = path.join(dir, 'xss.ndjson')
  texts.xss = writeWith(files.xss, { base: { hostname: 'fixture-host' } }, (log) => {
    log.info('</script><img src=x onerror=alert(1)>')
    log.info('line with \u2028 separator and </SCRIPT > variant')
  })

  return { dir, files, texts }
}

module.exports = { buildFixtures, writeWith, tmpDir }
