#!/usr/bin/env bun
// Backfill grammar-history.json from past Antigravity transcripts.
//
//   bun scripts/import-history.ts                 # last 7 days (default; requires configured endpoint)
//   bun scripts/import-history.ts --days 30       # up to 90 days
//   bun scripts/import-history.ts --dry-run       # count prompts, no model calls
//   bun scripts/import-history.ts --delay-ms 1000 # optional delay (ms) between batches
//   bun scripts/import-history.ts --brain-dir ~/.gemini/antigravity-cli/brain
import { createReadStream, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import { BATCH, fallbackFor, keepFixes, parseBatch, system } from '../src/check'
import { AUTO, compileIgnore, compileSkip, cut, joinNames, keptLanguage, languagesOf, lettersFor, loadConfigAndLists, resolvePaths, wordCount } from '../src/config'
import type { Settings } from '../src/config'
import { EMPTY_HISTORY, KEEP_DAYS, dayOf, historyText, importWindow, merge, parseHistory, record } from '../src/history'
import type { History } from '../src/history'
import { checkerOf, completeCheck } from '../src/providers'
import { batches, resolveImportPolicy, typedAgyText } from '../src/transcript'
import type { TranscriptPrompt } from '../src/transcript'
import type { GrammarFix, GrammarReply } from '../src/types'

const CALL_TIMEOUT_MS = 180_000
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}
const dryRun = args.includes('--dry-run')
const days = Number(flag('--days') ?? 7)

const fail: (text: string) => never = text => {
  console.error(text)
  process.exit(1)
}

let delayMs: number | undefined
if (args.includes('--delay-ms')) {
  delayMs = Number(flag('--delay-ms'))
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    fail('--delay-ms takes a non-negative whole number in milliseconds.')
  }
}

if (!Number.isInteger(days) || days < 1 || days > KEEP_DAYS) {
  fail(`--days takes a whole number from 1 to ${KEEP_DAYS}, the days the history keeps.`)
}

const defaultBrainDirs = () => {
  const home = homedir()
  return [
    join(home, '.gemini', 'antigravity-cli', 'brain'),
    join(home, '.gemini', 'antigravity', 'brain'),
    join(home, '.gemini', 'antigravity-ide', 'brain'),
  ].filter(d => existsSync(d))
}

const brainDirs = flag('--brain-dir')
  ? [flag('--brain-dir')!.replace(/^~(?=\/)/, homedir())]
  : defaultBrainDirs()

const findTranscriptFiles = (dirs: readonly string[], from: number): Array<{ file: string; conversationId: string }> => {
  const files: Array<{ file: string; conversationId: string }> = []
  for (const root of dirs) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root)) {
      const convDir = join(root, entry)
      try {
        if (!statSync(convDir).isDirectory()) continue
      } catch {
        continue
      }
      const logsDir = join(convDir, '.system_generated', 'logs')
      const full = join(logsDir, 'transcript_full.jsonl')
      const compact = join(logsDir, 'transcript.jsonl')
      const target = existsSync(full) ? full : existsSync(compact) ? compact : undefined
      if (target !== undefined && statSync(target).mtimeMs >= from) {
        files.push({ file: target, conversationId: basename(convDir) })
      }
    }
  }
  return files
}

const findPrompts = async (
  dirs: readonly string[],
  from: number,
  to: number,
  s: Settings,
  skipRegexes: readonly RegExp[],
): Promise<{ prompts: TranscriptPrompt[]; skipped: number }> => {
  const files = findTranscriptFiles(dirs, from)
  if (files.length === 0) {
    return { prompts: [], skipped: 0 }
  }
  const seen = new Set<string>()
  const found: Omit<TranscriptPrompt, 'id'>[] = []
  let skipped = 0

  for (const { file, conversationId } of files) {
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      const p = typedAgyText(line, conversationId)
      if (p === undefined || p.at < from || p.at >= to || seen.has(p.key)) {
        continue
      }
      seen.add(p.key)
      if (p.text.startsWith('/') || !lettersFor(s.language).test(p.text) || wordCount(p.text) < s.minWords) {
        continue
      }
      if (skipRegexes.some(re => re.test(p.text))) {
        skipped += 1
        continue
      }
      found.push(p)
    }
  }
  found.sort((a, b) => a.at - b.at)
  return { prompts: found.map((p, id) => ({ ...p, id })), skipped }
}

const main = async () => {
  const paths = resolvePaths(process.cwd())
  const { settings: s, lists } = loadConfigAndLists(paths)
  if (!s.history) {
    fail('The history is off in your settings (/grammar history on turns it on); nothing imported.')
  }
  if (brainDirs.length === 0) {
    fail('No Antigravity transcript directories found under ~/.gemini/. Pass --brain-dir <path>.')
  }
  const policy = resolveImportPolicy(s, { dryRun, delayMs })
  if (!policy.ok) {
    fail(policy.error)
  }

  let existing = EMPTY_HISTORY
  if (existsSync(paths.historyFile)) {
    try {
      existing = parseHistory(readFileSync(paths.historyFile, 'utf8'))
    } catch (err) {
      fail(`${paths.historyFile} does not parse (${err instanceof Error ? err.message : String(err)}); fix it or run /grammar history clear first.`)
    }
  }

  const first = existing.days[0]?.day
  const span = importWindow(Date.now(), days, first)
  if (span === undefined) {
    console.log(`The history already covers the last ${days} days (from ${first}); nothing to import.`)
    return
  }

  const { from, to } = span
  const ignore = compileIgnore(lists.ignore)
  const { prompts, skipped } = await findPrompts(brainDirs, from, to, s, compileSkip(lists.skip))
  const calls = batches(prompts)
  const callTimeoutMs = Math.max(CALL_TIMEOUT_MS, policy.delayMs + 60_000)

  console.log(
    `${prompts.length} prompts typed from ${dayOf(from)} to ${first === undefined ? 'now' : `the end of ${dayOf(to - 1)}`} (UTC)` +
      `${skipped > 0 ? ` (${skipped} more skipped by skip list)` : ''}; ${calls.length} calls to ${checkerOf(s)}.`,
  )
  if (dryRun || prompts.length === 0) {
    if (dryRun && s.endpoint === '') {
      console.log('Note: running without --dry-run requires an OpenAI-compatible endpoint (/grammar config endpoint <url>).')
    }
    return
  }

  const sys = `${system({ natural: false, language: s.language, dialect: s.dialect, showWhy: s.showWhy, kind: true, ignore: ignore.words })}\n${BATCH}`
  const results = new Map<number, { fixes: GrammarFix[]; language: string } | null>()
  let done = 0

  const ask = async (batch: TranscriptPrompt[]) => {
    const input = JSON.stringify(batch.map(p => ({ id: p.id, text: cut(p.text, s.maxChars) })))
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await completeCheck(s, sys, input, callTimeoutMs)
      if (!r.isAnswered) {
        if (attempt === 1) {
          console.error(`\n  a call failed twice, ${batch.length} prompts left out: ${r.reason}`)
        }
        continue
      }
      try {
        const replies = parseBatch(r.text, fallbackFor(s.language))
        if (replies.size === 0) {
          throw new Error(`no usable answer: ${r.text.slice(0, 120)}`)
        }
        return replies
      } catch (err) {
        if (attempt === 1) {
          console.error(`\n  a call failed twice, ${batch.length} prompts left out: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    return new Map<number, GrammarReply | null>()
  }

  const queue = [...calls]
  const worker = async () => {
    for (let batch = queue.shift(); batch !== undefined; batch = queue.shift()) {
      const replies = await ask(batch)
      const missing = batch.filter(p => !replies.has(p.id))
      if (missing.length > 0 && missing.length < batch.length) {
        for (const [id, r] of await ask(missing)) {
          replies.set(id, r)
        }
      }
      for (const p of batch) {
        const reply = replies.get(p.id)
        if (reply === undefined) continue
        const language = reply === null ? undefined : keptLanguage(s.language, reply.language)
        results.set(p.id, reply === null || language === undefined ? null : { fixes: keepFixes(reply.fixes, p.text, ignore), language })
      }
      done += 1
      process.stdout.write(`\r  ${done}/${calls.length} calls`)
      if (policy.delayMs > 0 && queue.length > 0) {
        await sleep(policy.delayMs)
      }
    }
  }

  await Promise.all(Array.from({ length: policy.parallel }, worker))
  process.stdout.write('\n')

  let imported = EMPTY_HISTORY
  for (const p of prompts) {
    const r = results.get(p.id)
    if (r !== undefined && r !== null) {
      imported = record(imported, r.fixes, p.at, r.language)
    }
  }

  let latest: History = existing
  if (existsSync(paths.historyFile)) {
    try {
      latest = parseHistory(readFileSync(paths.historyFile, 'utf8'))
    } catch {
      latest = existing
    }
  }

  const { mkdirSync } = await import('node:fs')
  mkdirSync(dirname(paths.historyFile), { recursive: true })
  const temp = `${paths.historyFile}.import-${process.pid}`
  writeFileSync(temp, historyText(merge(imported, latest, Date.now())), 'utf8')
  renameSync(temp, paths.historyFile)

  const checked = imported.days.reduce((n, d) => n + d.checked, 0)
  const withFixes = imported.days.reduce((n, d) => n + d.withFixes, 0)
  const notChecked = [...results.values()].filter(r => r === null).length
  const which = s.language === AUTO ? '' : ` in ${joinNames(languagesOf(s.language))}`
  const failed = prompts.length - results.size
  console.log(
    `${checked} prompts${which} checked, ${withFixes} with a fix, ${imported.fixes.length} fixes kept; ` +
      `${notChecked} ${s.language === AUTO ? 'with no prose to check' : `not in ${joinNames(languagesOf(s.language))}`}${failed > 0 ? `, ${failed} left out` : ''}.\n` +
      `Written to ${paths.historyFile}. /grammar stats shows them.`,
  )
}

await main()
