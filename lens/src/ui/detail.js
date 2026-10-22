'use strict'
/**
 * pino-lens — entry detail renderer.
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
  const MAX_INITIAL_KEYS = 40

  function isPlainObject (v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
  }

  function valueNode (value, depth) {
    if (value === null) return span('pl-json-null', 'null')
    if (typeof value === 'string') {
      const el = span('pl-json-string', JSON.stringify(value))
      if (value === '[Redacted]' || value === '[REDACTED]') el.classList.add('pl-json-redacted')
      return el
    }
    if (typeof value === 'number') return span('pl-json-number', String(value))
    if (typeof value === 'boolean') return span('pl-json-bool', String(value))
    if (Array.isArray(value)) {
      if (value.length === 0) return span('pl-json-bracket', '[ ]')
      const list = document.createElement('div')
      list.className = 'pl-json-children'
      for (let i = 0; i < value.length; i++) {
        const row = document.createElement('div')
        row.className = 'pl-json-row'
        row.append(span('pl-json-key', String(i) + ': '), valueNode(value[i], depth + 1))
        list.appendChild(row)
      }
      return collapsible('[' + value.length + ']', list, depth < 1)
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value)
      if (keys.length === 0) return span('pl-json-bracket', '{ }')
      const list = document.createElement('div')
      list.className = 'pl-json-children'
      const shown = depth < 1 ? keys : keys.slice(0, MAX_INITIAL_KEYS)
      for (const key of shown) {
        const row = document.createElement('div')
        row.className = 'pl-json-row'
        row.append(span('pl-json-key', key + ': '), valueNode(value[key], depth + 1))
        list.appendChild(row)
      }
      if (shown.length < keys.length) {
        const more = document.createElement('div')
        more.className = 'pl-json-more'
        more.textContent = '+ ' + (keys.length - shown.length) + ' more keys (export NDJSON to see all)'
        list.appendChild(more)
      }
      return collapsible('{' + keys.length + '}', list, depth < 1)
    }
    return span('pl-json-null', String(value))
  }

  function collapsible (label, children, open) {
    const details = document.createElement('details')
    details.className = 'pl-json-group'
    if (open) details.open = true
    const summary = document.createElement('summary')
    summary.textContent = label
    details.append(summary, children)
    return details
  }

  function span (cls, text) {
    const el = document.createElement('span')
    el.className = cls
    el.textContent = text
    return el
  }

  function createDetail (cfg) {
    const { container } = cfg
    let current = null

    function renderEmpty (message) {
      container.replaceChildren()
      const p = document.createElement('p')
      p.className = 'pl-detail-empty'
      p.textContent = message || 'Select a row to inspect its fields.'
      container.appendChild(p)
    }

    /**
     * @param {{index:number, obj:object|null, raw:string, levelName:string, timeMs:number, msg:string}} entry
     */
    function render (entry) {
      current = entry
      if (!entry) return renderEmpty()
      container.replaceChildren()

      const head = document.createElement('div')
      head.className = 'pl-detail-head'
      const level = span('pl-pill pl-lvl-' + String(entry.levelName).toLowerCase(), entry.levelName)
      const lineNo = span('pl-detail-line', 'line ' + (entry.index + 1))
      const time = span('pl-detail-time', Number.isFinite(entry.timeMs) ? new Date(entry.timeMs).toISOString() : 'no timestamp')
      head.append(level, time, lineNo)
      container.appendChild(head)

      const actions = document.createElement('div')
      actions.className = 'pl-detail-actions'
      actions.append(
        button('Copy JSON', () => copyText(entry.obj ? JSON.stringify(entry.obj, null, 2) : entry.raw)),
        button('Copy raw line', () => copyText(entry.raw))
      )
      container.appendChild(actions)

      if (!entry.obj) {
        const warn = document.createElement('p')
        warn.className = 'pl-detail-empty'
        warn.textContent = 'This line could not be parsed as JSON — the raw bytes are shown below.'
        container.appendChild(warn)
      } else {
        const err = entry.obj.err
        if (err && typeof err === 'object' && (err.stack || err.message)) {
          const box = document.createElement('div')
          box.className = 'pl-err'
          const title = document.createElement('div')
          title.className = 'pl-err-title'
          title.textContent = (err.type ? err.type + ': ' : '') + (err.message || 'error')
          box.appendChild(title)
          if (err.stack) {
            const pre = document.createElement('pre')
            pre.className = 'pl-err-stack'
            pre.textContent = err.stack
            box.appendChild(pre)
          }
          container.appendChild(box)
        }

        const tree = document.createElement('div')
        tree.className = 'pl-json'
        tree.appendChild(valueNode(entry.obj, 0))
        container.appendChild(tree)
      }

      const rawTitle = document.createElement('div')
      rawTitle.className = 'pl-raw-title'
      rawTitle.textContent = 'raw line (' + entry.raw.length + ' chars)'
      const raw = document.createElement('pre')
      raw.className = 'pl-raw'
      raw.textContent = entry.raw
      container.append(rawTitle, raw)
    }

    function button (label, onClick) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'pl-btn pl-btn-ghost'
      b.textContent = label
      b.addEventListener('click', () => {
        onClick()
        b.classList.add('is-active')
        setTimeout(() => b.classList.remove('is-active'), 600)
      })
      return b
    }

    async function copyText (text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
        } else {
          throw new Error('clipboard unavailable')
        }
      } catch (err) {
        // file:// pages and headless runs often lack clipboard permission.
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy') } catch (e) { /* ignore */ }
        ta.remove()
      }
    }

    return { render, renderEmpty, get current () { return current } }
  }

  return { createDetail, valueNode }
})
