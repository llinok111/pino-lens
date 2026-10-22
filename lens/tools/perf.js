'use strict'
/**
 * Performance harness (not part of `npm test`).
 *
 *   node tools/perf.js [dataset.ndjson ...]
 *
 * For each dataset: build a report with the CLI, open it in headless Chromium,
 * and measure parse / filter / sort / DOM size / JS heap. Results are printed
 * and written to test/tmp/perf-results.json. Numbers are machine-specific;
 * run it on your own box before quoting them.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { findBrowser, launch } = require('../test/browser/helpers/browser')

const ROOT = path.resolve(__dirname, '..')
const CLI = path.join(ROOT, 'bin', 'pino-lens.js')
const OUT = path.join(ROOT, 'test', 'tmp')

async function measure (page, report, label) {
  const started = Date.now()
  await page.goto('file://' + report, { waitUntil: 'load' })
  await page.waitForSelector('.pl-row', { timeout: 120000 })
  const loadMs = Date.now() - started

  const probe = await page.evaluate(() => {
    const P = window.PinoLens
    const api = window.__pinoLens.api
    const st = window.__pinoLens.state
    const best = (fn, runs) => {
      let min = Infinity
      for (let i = 0; i < (runs || 5); i++) {
        const t = performance.now()
        fn()
        const d = performance.now() - t
        if (d < min) min = d
      }
      return Number(min.toFixed(2))
    }
    const q = (text) => P.parseQuery(text, { levels: st.meta.levels })

    // Pure filter/sort passes (no aggregation, no DOM) — the core cost.
    const msgQuery = q('msg~"request completed"')
    const fieldQuery = q('route="/api/items"')
    const levelQuery = q('level>=warn')
    const msgFilterMs = best(() => P.filterStore(st.store, msgQuery))
    const fieldFilterMs = best(() => P.filterStore(st.store, fieldQuery))
    const levelFilterMs = best(() => P.filterStore(st.store, levelQuery))
    const rowsForSort = P.filterStore(st.store, q(''))
    const sortMs = best(() => P.sortIndices(st.store, rowsForSort, 'duration', 'desc'), 3)

    // End-to-end: what a keystroke costs (filter + sort + stats + render).
    const endToEndMs = best(() => api.setQuery('msg~"request completed"'), 3)
    api.setQuery('')
    const rows = st.rows.length

    return {
      entries: st.store.count,
      bytes: st.store.bytes,
      parseMs: Number(st.timings.build.toFixed(1)),
      domRows: document.querySelectorAll('.pl-row').length,
      msgFilterMs,
      fieldFilterMs,
      levelFilterMs,
      sortMs,
      endToEndMs,
      rows
    }
  })
  const cdp = await page.metrics()

  const heapMB = cdp.JSHeapUsedSize ? Number((cdp.JSHeapUsedSize / 1048576).toFixed(1)) : null
  return { label, loadMs, ...probe, heapMB }
}

async function main () {
  const browserPath = findBrowser()
  if (!browserPath) throw new Error('no Chromium-family browser found; set PL_EDGE')
  const datasets = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
        path.join(ROOT, 'examples', 'traffic-service', 'data', 'traffic.ndjson'),
        path.join(ROOT, 'examples', 'traffic-service', 'data', 'stress.ndjson')
      ].filter(p => fs.existsSync(p))

  fs.mkdirSync(OUT, { recursive: true })
  const browser = await launch()
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const rows = []

  for (const dataset of datasets) {
    const label = path.basename(dataset)
    const report = path.join(OUT, 'perf-' + label.replace(/\.ndjson$/, '') + '.html')
    const t0 = Date.now()
    execFileSync(process.execPath, [CLI, 'build', dataset, '-o', report, '--levels', 'notice=35'], { encoding: 'utf8' })
    const cliBuildMs = Date.now() - t0
    const htmlBytes = fs.statSync(report).size
    const result = await measure(page, report, label)
    rows.push({ ...result, cliBuildMs, reportMB: Number((htmlBytes / 1048576).toFixed(1)) })
    process.stdout.write(label + ' done\n')
  }

  await browser.close()

  const payload = {
    capturedAt: new Date().toISOString(),
    browser: browserPath,
    node: process.version,
    platform: process.platform + ' ' + process.arch,
    note: 'single-machine measurement, headless Chromium, file:// load, cold page per dataset',
    results: rows
  }
  fs.writeFileSync(path.join(OUT, 'perf-results.json'), JSON.stringify(payload, null, 2) + '\n')

  const header = ['dataset', 'entries', 'MB', 'cli build', 'load', 'parse', 'filter msg', 'filter field', 'filter level', 'sort', 'keystroke', 'dom rows', 'heap MB']
  const table = rows.map(r => [
    r.label, String(r.entries), String(r.reportMB), r.cliBuildMs + ' ms', r.loadMs + ' ms',
    r.parseMs + ' ms', r.msgFilterMs + ' ms', r.fieldFilterMs + ' ms', r.levelFilterMs + ' ms',
    r.sortMs + ' ms', r.endToEndMs + ' ms', String(r.domRows), String(r.heapMB)
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...table.map(row => row[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  process.stdout.write('\n' + line(header) + '\n' + line(widths.map(w => '-'.repeat(w))) + '\n')
  for (const row of table) process.stdout.write(line(row) + '\n')
  process.stdout.write('\nwritten to test/tmp/perf-results.json\n')
}

main().catch((err) => {
  process.stderr.write('perf failed: ' + (err && err.stack ? err.stack : err) + '\n')
  process.exit(1)
})
