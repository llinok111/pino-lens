'use strict'

const fs = require('node:fs')

const CANDIDATES = [
  process.env.PL_EDGE,
  process.env.PL_CHROME,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].filter(Boolean)

function findBrowser () {
  for (const candidate of CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch (err) { /* ignore */ }
  }
  return null
}

async function launch (options) {
  const puppeteer = require('puppeteer-core')
  const executablePath = findBrowser()
  if (!executablePath) return null
  return puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--font-render-hinting=none'],
    ...options
  })
}

module.exports = { findBrowser, launch }
