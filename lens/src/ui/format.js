'use strict'
/**
 * pino-lens — display formatting helpers.
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
  function pad (n, width) {
    return String(n).padStart(width || 2, '0')
  }

  function formatClock (ms) {
    if (!Number.isFinite(ms)) return '—'
    const d = new Date(ms)
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0')
  }

  function formatDateTime (ms) {
    if (!Number.isFinite(ms)) return '—'
    const d = new Date(ms)
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  }

  function formatDuration (ms) {
    if (!Number.isFinite(ms)) return '—'
    if (ms < 1) return ms.toFixed(2) + ' ms'
    if (ms < 1000) return ms.toFixed(1) + ' ms'
    if (ms < 60000) return (ms / 1000).toFixed(2) + ' s'
    return (ms / 60000).toFixed(1) + ' min'
  }

  function formatBytes (bytes) {
    if (!Number.isFinite(bytes)) return '—'
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  }

  function formatCount (n) {
    if (!Number.isFinite(n)) return '—'
    return n.toLocaleString('en-US')
  }

  function formatPercent (ratio) {
    if (!Number.isFinite(ratio)) return '—'
    return (ratio * 100).toFixed(ratio > 0 && ratio < 0.01 ? 2 : 1) + '%'
  }

  return { formatClock, formatDateTime, formatDuration, formatBytes, formatCount, formatPercent }
})
