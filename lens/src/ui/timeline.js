'use strict'
/**
 * pino-lens — stacked timeline with drag-to-filter.
 * MIT License. See lens/LICENSE.
 */

;(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.PinoLens = root.PinoLens || {}
    Object.assign(root.PinoLens, factory())
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LEVEL_ORDER = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
  const FALLBACK_COLORS = {
    trace: '#8b949e',
    debug: '#39a0a8',
    info: '#4e9a51',
    warn: '#c98a17',
    error: '#c2412d',
    fatal: '#8e3b8e',
    other: '#7a7a7a'
  }

  function colorFor (name, styles) {
    const key = LEVEL_ORDER.includes(name) ? name : 'other'
    const cssVar = '--pl-lvl-' + key
    const value = styles.getPropertyValue(cssVar).trim()
    return value || FALLBACK_COLORS[key]
  }

  /**
   * @param {{canvas: HTMLCanvasElement, tooltip: HTMLElement, onBrush: Function, onClear: Function}} cfg
   */
  function createTimeline (cfg) {
    const { canvas, tooltip, onBrush, onClear } = cfg
    let summary = null
    let selection = { from: null, to: null }
    let drag = null
    let geometry = null
    let hoverIndex = -1

    function resize () {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      const w = Math.max(120, Math.floor(rect.width))
      const h = Math.max(60, Math.floor(rect.height))
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      geometry = { width: w, height: h }
      draw()
    }

    function draw () {
      if (!geometry) return
      const ctx = canvas.getContext('2d')
      const { width, height } = geometry
      ctx.clearRect(0, 0, width, height)
      const styles = window.getComputedStyle(document.documentElement)
      const gridColor = styles.getPropertyValue('--pl-grid').trim() || 'rgba(127,127,127,.25)'
      const mutedColor = styles.getPropertyValue('--pl-muted').trim() || '#888'
      const padTop = 10
      const padBottom = 18
      const plotH = height - padTop - padBottom

      if (!summary || !summary.buckets || summary.buckets.length === 0) {
        ctx.fillStyle = mutedColor
        ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.fillText('no timed entries in the current selection', 12, height / 2)
        geometry.bars = []
        return
      }

      const buckets = summary.buckets
      const max = Math.max(1, ...buckets.map(b => b.total))
      const barW = width / buckets.length

      // horizontal guides
      ctx.strokeStyle = gridColor
      ctx.lineWidth = 1
      for (let g = 0; g <= 2; g++) {
        const y = padTop + (plotH * g) / 2
        ctx.beginPath()
        ctx.moveTo(0, Math.round(y) + 0.5)
        ctx.lineTo(width, Math.round(y) + 0.5)
        ctx.stroke()
      }

      geometry.bars = []
      for (let b = 0; b < buckets.length; b++) {
        const bucket = buckets[b]
        const x = b * barW
        let y = padTop + plotH
        for (const name of LEVEL_ORDER) {
          const count = bucket.levels[name]
          if (!count) continue
          const h = (count / max) * plotH
          ctx.fillStyle = colorFor(name, styles)
          ctx.fillRect(x, y - h, Math.max(1, barW - 0.6), h)
          y -= h
        }
        let otherTotal = 0
        for (const key of Object.keys(bucket.levels)) {
          if (!LEVEL_ORDER.includes(key)) otherTotal += bucket.levels[key]
        }
        if (otherTotal) {
          const h = (otherTotal / max) * plotH
          ctx.fillStyle = colorFor('other', styles)
          ctx.fillRect(x, y - h, Math.max(1, barW - 0.6), h)
        }
        geometry.bars.push({ x, w: barW, bucket })
      }

      // axis labels
      ctx.fillStyle = mutedColor
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
      const first = buckets[0].t0
      const last = buckets[buckets.length - 1].t1
      ctx.fillText(formatTick(first), 2, height - 5)
      const lastLabel = formatTick(last)
      ctx.fillText(lastLabel, width - ctx.measureText(lastLabel).width - 2, height - 5)
      ctx.fillText('max ' + max, 2, padTop + 9)

      // selection overlay
      if (selection.from !== null || selection.to !== null) {
        const x0 = timeToX(selection.from === null ? first : selection.from)
        const x1 = timeToX(selection.to === null ? last : selection.to)
        ctx.fillStyle = styles.getPropertyValue('--pl-brush').trim() || 'rgba(78,154,81,.18)'
        ctx.fillRect(x0, padTop, Math.max(1, x1 - x0), plotH)
      }
      if (drag) {
        ctx.fillStyle = styles.getPropertyValue('--pl-brush').trim() || 'rgba(78,154,81,.18)'
        ctx.fillRect(Math.min(drag.x0, drag.x1), padTop, Math.abs(drag.x1 - drag.x0), plotH)
      }
      if (hoverIndex >= 0 && geometry.bars[hoverIndex]) {
        const bar = geometry.bars[hoverIndex]
        ctx.strokeStyle = styles.getPropertyValue('--pl-accent').trim() || '#4e9a51'
        ctx.strokeRect(bar.x + 0.5, padTop + 0.5, Math.max(1, bar.w - 1), plotH - 1)
      }
    }

    function formatTick (ms) {
      const d = new Date(ms)
      const pad = n => String(n).padStart(2, '0')
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    }

    function timeToX (ms) {
      if (!summary || !summary.buckets.length) return 0
      const first = summary.buckets[0].t0
      const last = summary.buckets[summary.buckets.length - 1].t1
      if (last <= first) return 0
      return Math.round(((ms - first) / (last - first)) * geometry.width)
    }

    canvas.addEventListener('pointerdown', (ev) => {
      if (!summary || !summary.buckets.length) return
      canvas.setPointerCapture(ev.pointerId)
      const x = ev.offsetX
      drag = { x0: x, x1: x }
      draw()
    })

    canvas.addEventListener('pointermove', (ev) => {
      if (!summary || !summary.buckets.length) return
      if (drag) {
        drag.x1 = ev.offsetX
        draw()
        return
      }
      const idx = Math.floor((ev.offsetX / geometry.width) * summary.buckets.length)
      hoverIndex = idx >= 0 && idx < summary.buckets.length ? idx : -1
      if (hoverIndex >= 0) {
        const bucket = summary.buckets[hoverIndex]
        const parts = LEVEL_ORDER.concat(['other'])
          .filter(n => bucket.levels[n])
          .map(n => n + ' ' + bucket.levels[n])
        tooltip.textContent = formatTick(bucket.t0) + ' · ' + bucket.total + ' entries' + (parts.length ? ' · ' + parts.join(' · ') : '')
        tooltip.style.display = 'block'
        const host = canvas.parentElement.getBoundingClientRect()
        const left = Math.min(host.width - 260, Math.max(0, ev.clientX - host.left + 12))
        tooltip.style.transform = 'translate(' + left + 'px,' + Math.max(0, ev.clientY - host.top - 34) + 'px)'
      } else {
        tooltip.style.display = 'none'
      }
      draw()
    })

    canvas.addEventListener('pointerup', (ev) => {
      if (!drag) return
      const x0 = Math.min(drag.x0, drag.x1)
      const x1 = Math.max(drag.x0, drag.x1)
      drag = null
      if (x1 - x0 < 4) {
        draw()
        return
      }
      const first = summary.buckets[0].t0
      const last = summary.buckets[summary.buckets.length - 1].t1
      const from = first + (x0 / geometry.width) * (last - first)
      const to = first + (x1 / geometry.width) * (last - first)
      onBrush(Math.floor(from), Math.ceil(to))
    })

    canvas.addEventListener('pointerleave', () => {
      hoverIndex = -1
      tooltip.style.display = 'none'
      if (!drag) draw()
    })

    canvas.addEventListener('dblclick', () => {
      onClear()
    })

    window.addEventListener('resize', resize)

    return {
      setData (nextSummary, nextSelection) {
        summary = nextSummary
        selection = nextSelection || { from: null, to: null }
        if (!geometry) resize()
        else draw()
      },
      resize,
      draw
    }
  }

  return { createTimeline, LEVEL_ORDER }
})
