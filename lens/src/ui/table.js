'use strict'
/**
 * pino-lens — windowed log table.
 * MIT License. See lens/LICENSE.
 *
 * Only the visible slice is in the DOM. With 250k rows this keeps the node
 * count near ~40 rows regardless of dataset size, which is what makes filters
 * feel instant without a framework or a worker.
 */

;(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.PinoLens = root.PinoLens || {}
    Object.assign(root.PinoLens, factory())
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ROW_HEIGHT = 26
  const OVERSCAN = 8

  /**
   * @param {object} cfg
   * @param {HTMLElement} cfg.container scroll container with `.pl-rows` child
   * @param {HTMLElement} cfg.windowEl absolutely positioned row host
   * @param {() => {store: object, rows: Int32Array, selected: number}} cfg.getView
   * @param {(rowIndex: number) => void} cfg.onActivate
   * @param {(rowIndex: number) => void} cfg.onSelect
   */
  function createTable (cfg) {
    const { container, windowEl, getView, onActivate, onSelect } = cfg
    let lastRange = { start: -1, end: -1 }
    let frame = null

    function schedule () {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        render()
      })
    }

    function render (force) {
      const view = getView()
      const { store, rows, selected } = view
      const total = rows.length
      const rowsHost = container.querySelector('.pl-rows')
      rowsHost.style.height = (total * ROW_HEIGHT) + 'px'

      const viewportHeight = container.clientHeight || 400
      const scrollTop = container.scrollTop
      const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
      const visible = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
      const end = Math.min(total, start + visible)
      if (!force && start === lastRange.start && end === lastRange.end && lastRange.sel === selected) return
      lastRange = { start, end, sel: selected }

      const frag = document.createDocumentFragment()
      for (let r = start; r < end; r++) {
        const i = rows[r]
        const row = document.createElement('div')
        row.className = 'pl-row'
        row.setAttribute('role', 'row')
        row.setAttribute('aria-rowindex', String(r + 1))
        row.dataset.row = String(r)
        if (r === selected) {
          row.classList.add('is-selected')
          row.setAttribute('aria-selected', 'true')
        }
        row.style.transform = 'translateY(' + (r * ROW_HEIGHT) + 'px)'

        const levelName = store.levelNames[store.level[i]]
        const levelCell = document.createElement('span')
        levelCell.className = 'pl-cell pl-level pl-lvl-' + cssLevel(levelName)
        levelCell.textContent = levelName

        const timeCell = document.createElement('span')
        timeCell.className = 'pl-cell pl-time'
        timeCell.textContent = formatClockValue(store.time[i])

        const msgCell = document.createElement('span')
        msgCell.className = 'pl-cell pl-msg'
        msgCell.textContent = store.msg[i]
        if ((store.flags[i] & 1) !== 0) {
          const badge = document.createElement('span')
          badge.className = 'pl-badge'
          badge.textContent = 'err'
          badge.title = 'record carries a serialised error'
          msgCell.appendChild(badge)
        }
        if ((store.flags[i] & 2) !== 0) {
          const badge = document.createElement('span')
          badge.className = 'pl-badge pl-badge-muted'
          badge.textContent = 'redacted'
          badge.title = 'contains pino redaction markers'
          msgCell.appendChild(badge)
        }

        const durCell = document.createElement('span')
        durCell.className = 'pl-cell pl-dur'
        const d = store.dur[i]
        durCell.textContent = Number.isFinite(d) ? d.toFixed(1) : ''

        row.append(timeCell, levelCell, msgCell, durCell)
        frag.appendChild(row)
      }
      windowEl.style.transform = 'translateY(' + (start * ROW_HEIGHT) + 'px)'
      windowEl.replaceChildren(frag)
    }

    function cssLevel (name) {
      return String(name).replace(/[^a-z0-9_-]/gi, '').toLowerCase()
    }

    function formatClockValue (ms) {
      if (!Number.isFinite(ms)) return '—'
      const d = new Date(ms)
      const pad = (n, w) => String(n).padStart(w || 2, '0')
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0')
    }

    container.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)

    container.addEventListener('click', (ev) => {
      const rowEl = ev.target.closest('.pl-row')
      if (!rowEl) return
      const r = Number(rowEl.dataset.row)
      onSelect(r)
      if (ev.detail > 1) onActivate(r)
      render(true)
    })

    container.addEventListener('keydown', (ev) => {
      const view = getView()
      const total = view.rows.length
      let next = view.selected
      const page = Math.max(1, Math.floor((container.clientHeight || 400) / ROW_HEIGHT) - 1)
      switch (ev.key) {
        case 'ArrowDown': next = Math.min(total - 1, view.selected + 1); break
        case 'ArrowUp': next = Math.max(0, view.selected - 1); break
        case 'PageDown': next = Math.min(total - 1, view.selected + page); break
        case 'PageUp': next = Math.max(0, view.selected - page); break
        case 'Home': next = 0; break
        case 'End': next = total - 1; break
        case 'Enter': onActivate(view.selected); ev.preventDefault(); return
        case ' ': onActivate(view.selected); ev.preventDefault(); return
        default: return
      }
      ev.preventDefault()
      onSelect(next)
      scrollToRow(next)
      render(true)
    })

    function scrollToRow (r) {
      const top = r * ROW_HEIGHT
      const bottom = top + ROW_HEIGHT
      if (top < container.scrollTop) container.scrollTop = top
      else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight
    }

    return { render, schedule, scrollToRow, ROW_HEIGHT }
  }

  return { createTable, ROW_HEIGHT, OVERSCAN }
})
