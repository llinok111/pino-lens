'use strict'
/**
 * pino-lens — Node entry point.
 * MIT License. See lens/LICENSE.
 *
 * Browser usage does not go through this file: the same core modules are
 * loaded as plain <script> tags (see assets/report-template.html) and register
 * themselves on `globalThis.PinoLens`.
 */

const ndjson = require('./core/ndjson')
const levels = require('./core/levels')
const normalize = require('./core/normalize')
const storeMod = require('./core/store')
const query = require('./core/query')
const aggregate = require('./core/aggregate')
const exporter = require('./core/exporter')

/**
 * Convenience wrapper used by the CLI and by tests.
 * @param {string} text NDJSON blob
 * @param {{query?: string, sort?: {key: string, dir: string}, levels?: object}} [options]
 */
function analyze (text, options) {
  const opts = options || {}
  const store = storeMod.buildStore(text, opts)
  const parsedQuery = query.parseQuery(opts.query || '', { levels: opts.levels })
  const indices = query.filterStore(store, parsedQuery)
  const sortKey = opts.sort && opts.sort.key ? opts.sort.key : 'line'
  const sortDir = opts.sort && opts.sort.dir ? opts.sort.dir : 'asc'
  const ordered = query.sortIndices(store, indices, sortKey, sortDir)
  return {
    store,
    query: parsedQuery,
    indices,
    ordered,
    summary: aggregate.summarize(store, ordered)
  }
}

module.exports = {
  version: require('../package.json').version,
  analyze,
  ...ndjson,
  ...levels,
  ...normalize,
  ...storeMod,
  ...query,
  ...aggregate,
  ...exporter
}
