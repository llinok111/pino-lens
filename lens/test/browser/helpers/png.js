'use strict'
/**
 * Minimal PNG reader used by the browser tests.
 *
 * Why: the UI checks in this suite must not rely on "does it look right to me".
 * They measure actual pixels (is anything painted? is the frame mostly blank?
 * is content clipped at the edges?) so a regression that produces a blank
 * canvas or a collapsed layout fails the build.
 *
 * Only 8-bit non-interlaced RGB/RGBA PNGs are supported — that is what
 * Chromium produces for page screenshots.
 */

const zlib = require('node:zlib')

function decodePng (buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const bitDepth = data[8]
      colorType = data[9]
      const interlace = data[12]
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error('unsupported PNG variant: depth=' + bitDepth + ' color=' + colorType + ' interlace=' + interlace)
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) {
        throw new Error('unknown PNG filter ' + filter)
      }
      out[x] = value & 0xff
    }
  }
  return { width, height, channels, pixels }
}

/**
 * Summarise a screenshot: theme luminance, blank-pixel share, and how much
 * ink falls into each named region.
 * @param {Buffer} buffer PNG bytes
 * @param {Array<{name: string, x: number, y: number, w: number, h: number}>} regions
 */
function analyse (buffer, regions) {
  const img = decodePng(buffer)
  const { width, height, channels, pixels } = img
  const hist = new Map()
  let lumaSum = 0
  const total = width * height
  for (let i = 0; i < total; i++) {
    const o = i * channels
    const r = pixels[o]
    const g = pixels[o + 1]
    const b = pixels[o + 2]
    lumaSum += 0.2126 * r + 0.7152 * g + 0.0722 * b
    const key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3)
    hist.set(key, (hist.get(key) || 0) + 1)
  }
  let dominant = 0
  for (const count of hist.values()) if (count > dominant) dominant = count

  const regionStats = (regions || []).map((region) => {
    let ink = 0
    let pixelsInRegion = 0
    const x0 = Math.max(0, Math.round(region.x))
    const y0 = Math.max(0, Math.round(region.y))
    const x1 = Math.min(width, Math.round(region.x + region.w))
    const y1 = Math.min(height, Math.round(region.y + region.h))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * width + x) * channels
        const key = (pixels[o] >> 3) << 10 | (pixels[o + 1] >> 3) << 5 | (pixels[o + 2] >> 3)
        pixelsInRegion++
        if ((hist.get(key) || 0) < dominant * 0.5) ink++
      }
    }
    return { name: region.name, coverage: pixelsInRegion ? ink / pixelsInRegion : 0 }
  })

  // Pixels that differ from the page background along the outer 2px frame:
  // a non-zero value there usually means content is clipped or overflowing.
  const edgeInk = (() => {
    let ink = 0
    let seen = 0
    const sample = (x, y) => {
      const o = (y * width + x) * channels
      const key = (pixels[o] >> 3) << 10 | (pixels[o + 1] >> 3) << 5 | (pixels[o + 2] >> 3)
      seen++
      if ((hist.get(key) || 0) < dominant * 0.5) ink++
    }
    for (let x = 0; x < width; x += 3) { sample(x, 0); sample(x, height - 1) }
    for (let y = 0; y < height; y += 3) { sample(0, y); sample(width - 1, y) }
    return seen ? ink / seen : 0
  })()

  return {
    width,
    height,
    meanLuma: lumaSum / total,
    theme: lumaSum / total > 140 ? 'light' : 'dark',
    dominantColorShare: dominant / total,
    distinctColors: hist.size,
    edgeInk,
    regions: regionStats
  }
}

module.exports = { decodePng, analyse }
