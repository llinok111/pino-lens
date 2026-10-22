'use strict'
/**
 * Browser integration tests.
 *
 * These run the generated report in a real Chromium engine (Edge/Chrome via
 * CDP), drive the actual controls, and compare what the UI shows against what
 * the CLI computes for the same query from a separate process. Screenshot
 * pixels are measured as well, so a blank canvas or a collapsed layout fails.
 *
 * Run: npm run test:browser   (set PL_EDGE / PL_CHROME to override the binary)
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { findBrowser, launch } = require('./helpers/browser')
const { analyse } = require('./helpers/png')

const ROOT = path.resolve(__dirname, '..', '..')
const CLI = path.join(ROOT, 'bin', 'pino-lens.js')
const DATASET = path.join(ROOT, 'examples', 'traffic-service', 'data', 'traffic.ndjson')
const OUT_DIR = path.join(ROOT, 'test', 'tmp')
const REPORT = path.join(OUT_DIR, 'browser-report.html')
const SHOT = path.join(OUT_DIR, 'browser-report.png')
const RESULT_FILE = path.join(OUT_DIR, 'browser-results.json')

const hasBrowser = Boolean(findBrowser()) && fs.existsSync(DATASET)
const skipReason = !findBrowser()
  ? 'no Chromium-family browser found; set PL_EDGE to run browser tests'
  : 'examples/traffic-service/data/traffic.ndjson missing; run npm run sample'

const results = {}

function cliJson (args) {
  return JSON.parse(execFileSync(process.execPath, [CLI].concat(args, ['--json']), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
}

function cliCount (query) {
  return cliJson(['stats', DATASET, '--query', query, '--levels', 'notice=35']).matched
}

let browser
let page
const pageErrors = []

test('browser suite', { skip: hasBrowser ? false : skipReason, timeout: 240000 }, async (t) => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  execFileSync(process.execPath, [CLI, 'build', DATASET, '-o', REPORT, '--title', 'browser suite', '--levels', 'notice=35'], { encoding: 'utf8' })
  browser = await launch()
  page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push('console: ' + msg.text()) })

  await t.test('report loads and virtualises a 60k+ entry file', async () => {
    const started = Date.now()
    await page.goto('file://' + REPORT, { waitUntil: 'load' })
    await page.waitForSelector('.pl-row', { timeout: 60000 })
    const loadMs = Date.now() - started
    const metrics = await page.evaluate(() => ({
      entries: window.__pinoLens.store.count,
      domRows: document.querySelectorAll('.pl-row').length,
      timings: window.__pinoLens.state.timings,
      meta: document.getElementById('pl-meta').textContent
    }))
    results.loadMs = loadMs
    results.entries = metrics.entries
    results.parseMs = Number(metrics.timings.build.toFixed(1))
    results.domRows = metrics.domRows

    assert.ok(metrics.entries > 60000, 'expected a 60k+ entry dataset, saw ' + metrics.entries)
    assert.ok(metrics.domRows < 90, 'only the visible window should be in the DOM, saw ' + metrics.domRows)
    assert.ok(results.parseMs < 5000, 'parse should stay interactive, took ' + results.parseMs + ' ms')
    assert.match(metrics.meta, /pino 10\./)
    assert.deepStrictEqual(pageErrors, [])
  })

  await t.test('timeline canvas actually paints stacked level bands', async () => {
    const canvas = await page.evaluate(() => {
      const el = document.getElementById('pl-chart')
      const ctx = el.getContext('2d')
      const { data } = ctx.getImageData(0, 0, el.width, el.height)
      let painted = 0
      const colors = new Set()
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 0) {
          painted++
          colors.add((data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4))
        }
      }
      return { painted, colors: colors.size, width: el.width, height: el.height }
    })
    results.canvasPaintedPixels = canvas.painted
    assert.ok(canvas.painted > 2000, 'canvas looks empty: ' + canvas.painted + ' painted pixels')
    assert.ok(canvas.colors >= 3, 'expected several level colours, saw ' + canvas.colors)
    assert.ok(canvas.width > 800 && canvas.height > 60, 'canvas is scaled to its box')
  })

  await t.test('layout has no overflow and panels do not overlap', async () => {
    const layout = await page.evaluate(() => {
      const rect = (id) => {
        const r = document.getElementById(id).getBoundingClientRect()
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) }
      }
      return {
        chart: rect('pl-chart'),
        table: rect('pl-table'),
        detail: rect('pl-detail'),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rowCells: Array.from(document.querySelector('.pl-row').children).map(c => ({ text: c.textContent.trim(), width: Math.round(c.getBoundingClientRect().width) }))
      }
    })
    assert.strictEqual(layout.overflowX, 0, 'page must not scroll horizontally')
    assert.ok(layout.table.top >= layout.chart.bottom - 1, 'timeline and table must not overlap')
    assert.ok(layout.table.height > 250, 'table needs usable height, got ' + layout.table.height)
    assert.ok(layout.detail.width >= 360, 'detail panel too narrow: ' + layout.detail.width)
    assert.strictEqual(layout.rowCells.length, 4, 'time / level / message / duration')
    assert.ok(layout.rowCells.every(c => c.width > 20), 'a table cell collapsed')
  })

  await t.test('filter typing matches an independent CLI count', async () => {
    await page.evaluate(() => { window.__pinoLens.api.setQuery('') })
    await page.click('#pl-search')
    await page.type('#pl-search', 'level>=error')
    await page.waitForFunction(() => window.__pinoLens.state.queryText === 'level>=error')
    await page.waitForFunction(() => /^\d/.test(document.getElementById('pl-count').textContent), { timeout: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 250))
    const ui = await page.evaluate(() => ({
      rows: window.__pinoLens.state.rows.length,
      countText: document.getElementById('pl-count').textContent,
      timings: window.__pinoLens.state.timings,
      domRows: document.querySelectorAll('.pl-row').length
    }))
    const expected = cliCount('level>=error')
    results.filterMs = Number(ui.timings.filter.toFixed(2))
    assert.strictEqual(ui.rows, expected, 'UI and CLI disagree on level>=error')
    assert.ok(ui.countText.includes(expected.toLocaleString('en-US')), 'status line shows the count')
    assert.ok(ui.timings.filter < 150, 'filtering 67k entries should stay under 150 ms, saw ' + ui.timings.filter)
  })

  await t.test('level chips and brush facets narrow the result further', async () => {
    await page.evaluate(() => {
      window.__pinoLens.api.setQuery('')
      window.__pinoLens.api.setLevels(['error'])
    })
    const errorOnly = await page.evaluate(() => window.__pinoLens.state.rows.length)
    assert.strictEqual(errorOnly, cliCount('level=error'))

    const brushed = await page.evaluate(() => {
      const st = window.__pinoLens.state
      let min = Infinity
      let max = -Infinity
      for (let i = 0; i < st.store.count; i++) {
        const t = st.store.time[i]
        if (!Number.isFinite(t)) continue
        if (t < min) min = t
        if (t > max) max = t
      }
      const from = Math.floor(min + (max - min) * 0.25)
      const to = Math.floor(min + (max - min) * 0.75)
      window.__pinoLens.api.setLevels(null)
      window.__pinoLens.api.setRange(from, to)
      return { rows: st.rows.length, from, to }
    })
    const expected = cliJson(['stats', DATASET, '--levels', 'notice=35', '--query', 'time>=' + brushed.from + ' time<' + brushed.to]).matched
    assert.strictEqual(brushed.rows, expected, 'brush range should match the equivalent query')
    await page.evaluate(() => window.__pinoLens.api.setRange(null, null))
  })

  await t.test('sorting by duration is correct at both ends', async () => {
    const sort = await page.evaluate(() => {
      const api = window.__pinoLens.api
      api.setQuery('')
      api.setSort('duration', 'desc')
      const st = window.__pinoLens.state
      const last = st.rows[st.rows.length - 1]
      let max = -Infinity
      let nanCount = 0
      for (let i = 0; i < st.store.count; i++) {
        const d = st.store.dur[i]
        if (Number.isFinite(d)) { if (d > max) max = d } else nanCount++
      }
      if (Number.isNaN(st.store.dur[rows0()])) nanCount++
      function rows0 () { return st.rows[0] }
      return {
        first: st.store.dur[st.rows[0]],
        second: st.store.dur[st.rows[1]],
        lastIsNaN: Number.isNaN(st.store.dur[last]),
        max,
        nanCount,
        rows: st.rows.length,
        firstIsFinite: Number.isFinite(st.store.dur[st.rows[0]])
      }
    })
    assert.ok(Math.abs(sort.first - sort.max) < 1e-9, 'top row must hold the maximum duration')
    assert.ok(sort.second <= sort.first, 'descending order')
    assert.ok(sort.nanCount > 0, 'dataset has entries without a duration (debug lines)')
    assert.ok(sort.lastIsNaN, 'entries without a duration stay at the bottom')
  })

  await t.test('detail view shows the serialised error and the raw line', async () => {
    const detail = await page.evaluate(() => {
      window.__pinoLens.api.setQuery('level=error msg~"handler threw"')
      window.__pinoLens.api.setSort('time', 'asc')
      window.__pinoLens.select(0)
      const box = document.getElementById('pl-detail')
      const i = window.__pinoLens.state.rows[0]
      return {
        stack: box.querySelector('.pl-err-stack')?.textContent || '',
        title: box.querySelector('.pl-err-title')?.textContent || '',
        raw: box.querySelector('.pl-raw')?.textContent || '',
        storeRaw: window.__pinoLens.store.raw[i],
        keys: box.querySelectorAll('.pl-json-key').length,
        pill: box.querySelector('.pl-pill')?.textContent || ''
      }
    })
    assert.match(detail.title, /Error|TypeError/)
    assert.match(detail.stack, /\n\s+at /, 'stack trace is rendered')
    assert.strictEqual(detail.raw, detail.storeRaw, 'raw line must be byte-identical')
    assert.ok(detail.keys >= 4, 'JSON tree exposes the fields')
    assert.strictEqual(detail.pill, 'error')
  })

  await t.test('keyboard navigation moves the selection', async () => {
    const before = await page.evaluate(() => {
      window.__pinoLens.api.setQuery('')
      window.__pinoLens.select(0)
      document.getElementById('pl-table').focus()
      return window.__pinoLens.state.selected
    })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    const after = await page.evaluate(() => ({
      selected: window.__pinoLens.state.selected,
      lineLabel: document.querySelector('.pl-detail-line')?.textContent,
      selectedRow: document.querySelectorAll('.pl-row.is-selected').length
    }))
    assert.strictEqual(after.selected, before + 2)
    assert.match(after.lineLabel, /^line 3$/)
    assert.strictEqual(after.selectedRow, 1, 'exactly one row is marked selected')
  })

  await t.test('exports match the filtered view', async () => {
    const out = await page.evaluate(() => {
      const api = window.__pinoLens.api
      api.setQuery('level>=error')
      const rows = window.__pinoLens.state.rows.length
      const csv = api.csv()
      const nd = api.ndjson()
      const lines = nd.replace(/\n$/, '').split('\n')
      const parsed = lines.map(l => { try { return JSON.parse(l) } catch (e) { return null } })
      return {
        rows,
        csvLines: csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n').length - 1,
        csvHeader: csv.replace(/^\uFEFF/, '').split('\r\n')[0],
        ndjsonLines: lines.length,
        allValid: parsed.every(Boolean),
        levels: Array.from(new Set(parsed.map(o => o.level))),
        summary: JSON.parse(api.summary())
      }
    })
    assert.strictEqual(out.csvLines, out.rows, 'CSV row count equals the filtered count')
    assert.strictEqual(out.ndjsonLines, out.rows, 'NDJSON line count equals the filtered count')
    assert.ok(out.allValid, 'every exported NDJSON line is valid JSON')
    assert.strictEqual(out.csvHeader, 'time_iso,level,msg,duration_ms')
    assert.deepStrictEqual(out.levels, [50], 'only error-level entries are exported for level>=error')
    assert.strictEqual(out.summary.summary.count, out.rows)
  })

  await t.test('a download click produces a real blob', async () => {
    const info = await page.evaluate(() => document.getElementById('pl-export-ndjson').click())
    assert.strictEqual(info, undefined)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const download = await page.evaluate(() => window.__lastDownload)
    assert.ok(download && download.size > 1000, 'blob was created: ' + JSON.stringify(download))
    assert.match(download.name, /^pino-lens-\d{8}-\d{6}\.ndjson$/)
  })

  await t.test('shareable hash restores filters on reload', async () => {
    const hash = '#q=level%3Derror&sort=duration&dir=desc&levels=error'
    await page.goto('file://' + REPORT + hash, { waitUntil: 'load' })
    await page.waitForSelector('.pl-row', { timeout: 60000 })
    const state = await page.evaluate(() => ({
      query: document.getElementById('pl-search').value,
      sort: document.getElementById('pl-sort').value,
      dir: document.getElementById('pl-dir').textContent,
      rows: window.__pinoLens.state.rows.length,
      chips: Array.from(document.querySelectorAll('.pl-chip[aria-pressed="true"]')).map(c => c.dataset.level)
    }))
    assert.strictEqual(state.query, 'level=error')
    assert.strictEqual(state.sort, 'duration')
    assert.strictEqual(state.dir, '↓')
    assert.deepStrictEqual(state.chips, ['error'])
    assert.strictEqual(state.rows, cliCount('level=error'), 'hash-restored level filter matches the CLI')
  })

  await t.test('accessibility wiring is present', async () => {
    const a11y = await page.evaluate(() => {
      const grid = document.getElementById('pl-table')
      return {
        labelForSearch: Boolean(document.querySelector('label[for="pl-search"]')),
        gridRole: grid.getAttribute('role'),
        rowCount: Number(grid.getAttribute('aria-rowcount')),
        rows: window.__pinoLens.state.rows.length,
        liveRegion: document.getElementById('pl-count').getAttribute('aria-live'),
        buttonsNamed: ['pl-export-csv', 'pl-export-ndjson', 'pl-export-summary'].every(id => document.getElementById(id).textContent.trim().length > 3),
        chipsPressed: Array.from(document.querySelectorAll('.pl-chip')).every(c => c.hasAttribute('aria-pressed'))
      }
    })
    assert.ok(a11y.labelForSearch)
    assert.strictEqual(a11y.gridRole, 'grid')
    assert.strictEqual(a11y.liveRegion, 'polite')
    assert.ok(a11y.buttonsNamed)
    assert.ok(a11y.chipsPressed)
    assert.ok(Number.isFinite(a11y.rowCount) && a11y.rowCount >= a11y.rows, 'aria-rowcount describes the result set')
  })

  await t.test('dark colour scheme keeps text and chart visible', async () => {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
    await page.goto('file://' + REPORT, { waitUntil: 'load' })
    await page.waitForSelector('.pl-row', { timeout: 60000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const shot = await page.screenshot()
    const stats = analyse(shot, [])
    results.darkScreenshot = { theme: stats.theme, meanLuma: Number(stats.meanLuma.toFixed(1)), dominantColorShare: Number(stats.dominantColorShare.toFixed(3)) }
    assert.strictEqual(stats.theme, 'dark', 'dark scheme should switch the palette')
    assert.ok(stats.meanLuma < 110, 'background should be dark, saw ' + stats.meanLuma)
    assert.ok(stats.dominantColorShare < 0.97, 'dark frame looks blank')
    assert.ok(stats.distinctColors > 50, 'expected rendered text and chart shades')
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
  })

  await t.test('screenshot pixels confirm a populated, unclipped frame', async () => {
    await page.goto('file://' + REPORT, { waitUntil: 'load' })
    await page.waitForSelector('.pl-row', { timeout: 60000 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const shot = await page.screenshot({ path: SHOT })
    const boxes = await page.evaluate(() => {
      const rect = (sel) => {
        const r = document.querySelector(sel).getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      }
      return {
        header: rect('.pl-header'),
        controls: rect('.pl-controls'),
        timeline: rect('#pl-timeline'),
        table: rect('.pl-table'),
        detail: rect('#pl-detail')
      }
    })
    const stats = analyse(shot, Object.entries(boxes).map(([name, r]) => ({ name, ...r })))
    results.screenshot = stats
    assert.ok(['light', 'dark'].includes(stats.theme))
    assert.ok(stats.dominantColorShare < 0.97, 'frame looks blank: dominant share ' + stats.dominantColorShare.toFixed(3))
    assert.ok(stats.edgeInk < 0.25, 'content appears clipped at the edges: ' + stats.edgeInk.toFixed(3))
    for (const region of stats.regions) {
      assert.ok(region.coverage > 0.01, 'region ' + region.name + ' looks empty (' + region.coverage.toFixed(4) + ')')
    }
    assert.deepStrictEqual(pageErrors, [], 'no runtime errors during the whole suite')
  })

  fs.writeFileSync(RESULT_FILE, JSON.stringify({ capturedAt: new Date().toISOString(), browser: findBrowser(), dataset: path.basename(DATASET), results }, null, 2) + '\n')

  await page.close()
  await browser.close()
})
