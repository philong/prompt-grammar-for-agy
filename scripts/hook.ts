#!/usr/bin/env node
// Antigravity hook entrypoint: reads stdin JSON, runs handleHook, writes stdout JSON.
import { readFileSync } from 'node:fs'

import { handleHook } from '../src/hook-handler'
import type { AgyHookInput } from '../src/types'

const main = async () => {
  try {
    const raw = readFileSync(0, 'utf8').trim()
    const payload = (raw === '' ? {} : JSON.parse(raw)) as AgyHookInput
    const out = await handleHook(payload)
    process.stdout.write(`${JSON.stringify(out)}\n`)
  } catch {
    // A grammar check failure must never block or crash the user's prompt.
    process.stdout.write('{}\n')
  }
}

await main()
