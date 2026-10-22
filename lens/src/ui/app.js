'use strict'
/**
 * pino-lens — application shell.
 * MIT License. See lens/LICENSE.
 *
 * No framework, no build step: this file is inlined verbatim into the report.
 */

;(function () {
  const P = window.PinoLens

  const state = {
    store: null,
    rows: new Int32Array(0),
    summary: null,
    queryText: '',
    levelFilter: null,
    range: { from: null, to: null },
    sortKey: 'time',
    sortDir: 'asc',
    selected: 0,
    timings: { build: 0, filter: 0, sort: 0 },
    meta: null,
    csvColumns: ['time_iso', 'level', 'msg', 'duration_ms']
  }

  const els = {}
  let table = null
  let detail = null
  let timeline = null
  let searchTimer = null

  function $ (id) { return document.getElementById(id) }

  function boot () {
    const node = $('pino-lens-data')
    if (!node) return showFatal('embedded data block is missing')
    const src = node.getAttribute('data-src')
    if (src) {
      fetch(src).then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.text()
      }).then(text => start({ meta: { title: src }, ndjson: text }))
        .catch(err => showFatal('could not load ' + src + ': ' + err.message))
      return
    }
    let payload
    try {
      payload = JSON.parse(node.textContent)
    } catch (err) {
      return showFatal('embedded data block is not valid JSON: ' + err.message)
    }
    start(payload)
  }

  function showFatal (message) {
    const box = document.createElement('div')
    box.className = 'pl-fatal'
    box.textContent = message
    document.body.appendChild(box)
  }

  function start (payload) {
    els.meta = $('pl-meta')
    els.issues = $('pl-issues')
    els.search = $('pl-search')
    els.levels = $('pl-levels')
    els.sort = $('pl-sort')
    els.dir = $('pl-dir')
    els.count = $('pl-count')
    els.chart = $('pl-chart')
    els.tip = $('pl-tip')
    els.timelineHost = $('pl-timeline')
    els.table = $('pl-table')
    els.detail = $('pl-detail')
    els.columns = $('pl-columns-list')

    const buildStart = performance.now()
    const text = typeof payload.ndjson === 'string' ? payload.ndjson : ''
    state.meta = payload.meta || {}
    state.store = P.buildStore(text, Object.assign({ levels: state.meta.levels }, state.meta.keys || {}))
    state.timings.build = performance.now() - buildStart

    document.title = state.meta.title ? state.meta.title + ' · pino-lens' : 'pino-lens'
    const titleEl = $('pl-title')
    if (titleEl && state.meta.title) titleEl.textContent = state.meta.title

    table = P.createTable({
      container: els.table,
      windowEl: els.table.querySelector('.pl-window'),
      getView: () => ({ store: state.store, rows: state.rows, selected: state.selected }),
      onSelect: (r) => select(r),
      onActivate: (r) => { select(r); els.detail.focus() }
    })
    detail = P.createDetail({ container: els.detail })
    timeline = P.createTimeline({
      canvas: els.chart,
      tooltip: els.tip,
      onBrush: (from, to) => {
        state.range = { from, to }
        apply()
      },
      onClear: () => {
        state.range = { from: null, to: null }
        apply()
      }
    })

    buildLevelChips()
    buildColumnPicker()
    bindControls()
    renderMeta()
    renderIssues()
    restoreFromHash()
    apply({ syncHash: false })
    timeline.resize()

    window.__pinoLens = {
      store: state.store,
      state,
      apply,
      select,
      api: {
        csv: () => P.toCSV(state.store, state.rows, { columns: state.csvColumns }),
        ndjson: () => P.toNDJSON(state.store, state.rows),
        summary: () => P.toSummaryJSON(state.summary, { title: state.meta.title, generatedAt: state.meta.generatedAt, sources: state.meta.sources }),
        setQuery: (q) => { els.search.value = q; state.queryText = q; apply({ syncHash: false }) },
        setSort: (key, dir) => { state.sortKey = key; state.sortDir = dir; els.sort.value = key; apply({ syncHash: false }) },
        setLevels: (names) => { state.levelFilter = names && names.length ? new Set(names) : null; buildLevelChips(); apply({ syncHash: false }) },
        setRange: (from, to) => { state.range = { from, to }; apply({ syncHash: false }) }
      }
    }

    document.body.classList.add('is-ready')
  }

  function renderMeta () {
    const s = state.store
    const parts = []
    parts.push(P.formatCount(s.count) + ' entries')
    parts.push(P.formatBytes(s.bytes))
    parts.push('parsed in ' + state.timings.build.toFixed(0) + ' ms')
    if (state.meta.generatedAt) parts.push('generated ' + state.meta.generatedAt)
    if (state.meta.pinoVersion) parts.push('pino ' + state.meta.pinoVersion)
    els.meta.textContent = parts.join(' · ')
  }

  function renderIssues () {
    const issues = state.store.issues
    const msgs = []
    if (issues.invalidJson) msgs.push(issues.invalidJson + ' invalid JSON line(s)')
    if (issues.notAnObject) msgs.push(issues.notAnObject + ' non-object line(s)')
    if (issues.oversizedLines) msgs.push(issues.oversizedLines + ' oversized line(s)')
    if (issues.emptyLines) msgs.push(issues.emptyLines + ' blank line(s)')
    if (issues.skippedByLimit) msgs.push(issues.skippedByLimit + ' line(s) beyond --limit')
    let missingTime = 0
    let unknownLevel = 0
    for (let i = 0; i < state.store.count; i++) {
      if (state.store.flags[i] & P.FLAG.TIME_MISSING) missingTime++
      if (state.store.flags[i] & P.FLAG.UNKNOWN_LEVEL) unknownLevel++
    }
    if (missingTime) msgs.push(missingTime + ' entry(ies) without a usable timestamp')
    if (unknownLevel) msgs.push(unknownLevel + ' entry(ies) with an unrecognised level')

    if (!msgs.length) {
      els.issues.hidden = true
      els.issues.replaceChildren()
      return
    }
    els.issues.hidden = false
    els.issues.replaceChildren()
    const badge = document.createElement('span')
    badge.className = 'pl-issues-badge'
    badge.textContent = 'data quality'
    const text = document.createElement('span')
    text.className = 'pl-issues-text'
    text.textContent = msgs.join(' · ')
    els.issues.append(badge, text)
    if (issues.samples.length) {
      const details = document.createElement('details')
      const summary = document.createElement('summary')
      summary.textContent = 'first ' + issues.samples.length + ' sample(s)'
      const pre = document.createElement('pre')
      pre.textContent = issues.samples.map(s => 'line ' + s.lineNo + ': ' + s.code + ' — ' + (s.snippet || s.message)).join('\n')
      details.append(summary, pre)
      els.issues.appendChild(details)
    }
  }

  function buildLevelChips () {
    const store = state.store
    const counts = new Map()
    if (state.summary) for (const l of state.summary.byLevel) counts.set(l.name, l.count)
    const names = store.levelNames.slice().sort((a, b) => levelSortValue(a) - levelSortValue(b) || a.localeCompare(b))
    els.levels.replaceChildren()
    for (const name of names) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'pl-chip pl-lvl-' + cssLevel(name)
      chip.setAttribute('aria-pressed', String(Boolean(state.levelFilter && state.levelFilter.has(name))))
      chip.dataset.level = name
      const label = document.createElement('span')
      label.textContent = name
      const num = document.createElement('span')
      num.className = 'pl-chip-count'
      num.textContent = counts.has(name) ? P.formatCount(counts.get(name)) : ''
      chip.append(label, num)
      chip.addEventListener('click', () => {
        const next = new Set(state.levelFilter || [])
        if (next.has(name)) next.delete(name)
        else next.add(name)
        state.levelFilter = next.size ? next : null
        buildLevelChips()
        apply()
      })
      els.levels.appendChild(chip)
    }
  }

  function levelSortValue (name) {
    const table = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }
    return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : 1000
  }

  function cssLevel (name) {
    return String(name).replace(/[^a-z0-9_-]/gi, '').toLowerCase()
  }

  function buildColumnPicker () {
    const store = state.store
    const core = ['level', 'time', 'msg', 'err']
    const candidates = store.columns
      .filter(c => !core.includes(c.key))
      .slice(0, 10)
    els.columns.replaceChildren()
    for (const col of candidates) {
      const label = document.createElement('label')
      label.className = 'pl-check'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.value = col.key
      box.addEventListener('change', () => {
        const extras = Array.from(els.columns.querySelectorAll('input:checked')).map(i => i.value)
        state.csvColumns = ['time_iso', 'level', 'msg', 'duration_ms'].concat(extras)
      })
      const span = document.createElement('span')
      span.textContent = col.key + ' (' + P.formatCount(col.count) + ')'
      label.append(box, span)
      els.columns.appendChild(label)
    }
  }

  function bindControls () {
    els.search.addEventListener('input', () => {
      state.queryText = els.search.value
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => apply(), 120)
    })
    els.sort.addEventListener('change', () => {
      state.sortKey = els.sort.value
      apply()
    })
    els.dir.addEventListener('click', () => {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'
      els.dir.textContent = state.sortDir === 'asc' ? '↑' : '↓'
      els.dir.setAttribute('aria-label', 'sort ' + state.sortDir + 'ending')
      apply()
    })
    $('pl-export-csv').addEventListener('click', () => download('pino-lens-' + stamp() + '.csv', P.toCSV(state.store, state.rows, { columns: state.csvColumns }), 'text/csv;charset=utf-8'))
    $('pl-export-ndjson').addEventListener('click', () => download('pino-lens-' + stamp() + '.ndjson', P.toNDJSON(state.store, state.rows), 'application/x-ndjson'))
    $('pl-export-summary').addEventListener('click', () => download('pino-lens-' + stamp() + '-summary.json', window.__pinoLens.api.summary(), 'application/json'))

    document.addEventListener('keydown', (ev) => {
      if (ev.key === '/' && document.activeElement !== els.search) {
        ev.preventDefault()
        els.search.focus()
      } else if (ev.key === 'Escape') {
        if (document.activeElement === els.search) {
          els.search.value = ''
          state.queryText = ''
          apply()
        } else if (state.range.from !== null || state.range.to !== null) {
          state.range = { from: null, to: null }
          apply()
        }
      }
    })

    window.addEventListener('hashchange', () => {
      restoreFromHash()
      apply({ syncHash: false })
    })
  }

  function restoreFromHash () {
    const hash = window.location.hash.replace(/^#/, '')
    if (!hash) return
    const params = new URLSearchParams(hash)
    if (params.has('q')) {
      state.queryText = params.get('q')
      els.search.value = state.queryText
    }
    if (params.has('sort')) {
      state.sortKey = params.get('sort')
      els.sort.value = state.sortKey
    }
    if (params.has('dir')) {
      state.sortDir = params.get('dir') === 'desc' ? 'desc' : 'asc'
      els.dir.textContent = state.sortDir === 'asc' ? '↑' : '↓'
    }
    if (params.has('levels')) {
      const list = params.get('levels').split(',').filter(Boolean)
      state.levelFilter = list.length ? new Set(list) : null
      buildLevelChips()
    }
    if (params.has('from') || params.has('to')) {
      state.range = {
        from: params.has('from') ? Number(params.get('from')) : null,
        to: params.has('to') ? Number(params.get('to')) : null
      }
    }
  }

  function syncHash () {
    const params = new URLSearchParams()
    if (state.queryText) params.set('q', state.queryText)
    if (state.sortKey !== 'time') params.set('sort', state.sortKey)
    if (state.sortDir !== 'asc') params.set('dir', state.sortDir)
    if (state.levelFilter && state.levelFilter.size) params.set('levels', Array.from(state.levelFilter).join(','))
    if (state.range.from !== null) params.set('from', String(state.range.from))
    if (state.range.to !== null) params.set('to', String(state.range.to))
    const next = params.toString()
    const target = next ? '#' + next : window.location.pathname + window.location.search
    try {
      window.history.replaceState(null, '', target)
    } catch (err) { /* file:// may refuse; harmless */ }
  }

  function apply (options) {
    const opts = options || {}
    const parsed = P.parseQuery(state.queryText, { levels: state.meta.levels })
    const combined = P.combine(parsed, { levels: state.levelFilter, from: state.range.from, to: state.range.to })

    const f0 = performance.now()
    const indices = P.filterStore(state.store, combined)
    const f1 = performance.now()
    const ordered = P.sortIndices(state.store, indices, state.sortKey, state.sortDir)
    const f2 = performance.now()

    state.rows = ordered
    els.table.setAttribute('aria-rowcount', String(ordered.length))
    state.summary = P.summarize(state.store, ordered)
    state.timings.filter = f1 - f0
    state.timings.sort = f2 - f1
    state.selected = ordered.length ? Math.min(state.selected, ordered.length - 1) : 0

    const parts = []
    parts.push(P.formatCount(ordered.length) + ' / ' + P.formatCount(state.store.count) + ' entries')
    parts.push('filter ' + state.timings.filter.toFixed(1) + ' ms')
    parts.push('sort ' + state.timings.sort.toFixed(1) + ' ms')
    if (state.summary.errorRate > 0) parts.push('errors ' + P.formatPercent(state.summary.errorRate))
    if (state.summary.duration) parts.push('p95 ' + P.formatDuration(state.summary.duration.p95))
    els.count.textContent = parts.join(' · ')

    if (parsed.errors.length) {
      els.count.textContent += ' · query: ' + parsed.errors.map(e => e.message).join('; ')
      els.count.classList.add('is-warn')
    } else {
      els.count.classList.remove('is-warn')
    }

    table.render(true)
    timeline.setData(state.summary, state.range)
    renderSelection()
    if (opts.syncHash !== false) syncHash()
  }

  function select (row) {
    if (!state.rows.length) {
      state.selected = 0
      detail.renderEmpty('No entries match the current filter.')
      return
    }
    state.selected = Math.max(0, Math.min(state.rows.length - 1, row))
    renderSelection()
    table.render(true)
  }

  function renderSelection () {
    if (!state.rows.length) {
      detail.renderEmpty('No entries match the current filter.')
      return
    }
    const i = state.rows[state.selected]
    detail.render({
      index: i,
      obj: P.getObject(state.store, i),
      raw: state.store.raw[i],
      levelName: state.store.levelNames[state.store.level[i]],
      timeMs: state.store.time[i],
      msg: state.store.msg[i]
    })
  }

  function stamp () {
    const d = new Date()
    const pad = n => String(n).padStart(2, '0')
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
  }

  function download (name, text, mime) {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    window.__lastDownload = { name, size: blob.size, mime }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
