#!/usr/bin/env node
// Antigravity CLI statusLine command: reads status JSON from stdin and prints the latest check with ANSI colors.
import { readFileSync } from 'node:fs'

import { renderStatusLine } from '../src/statusline'
import type { AgyStatusLineInput } from '../src/statusline'

const main = () => {
  try {
    const raw = readFileSync(0, 'utf8').trim()
    const payload = (raw === '' ? {} : JSON.parse(raw)) as AgyStatusLineInput
    const out = renderStatusLine(payload)
    if (out !== '') {
      process.stdout.write(`${out}\n`)
    }
  } catch {
    // Status line commands must never print errors or block the TUI.
  }
}

main()
