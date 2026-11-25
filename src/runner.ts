// Core prompt checking pipeline shared between synchronous PreInvocation and async background worker.
import { fallbackFor, keepFixes, parseReply, system, typedPart, usefulNatural } from './check'
import { ENGLISH, compileIgnore, compileSkip, cut, keptLanguage, lettersFor, wordCount } from './config'
import type { Lists, Paths, Settings } from './config'
import { STREAK_FROM, ansiClean, ansiError, ansiFixes, cleanText, markdownFixes, plainFixes, statusLinePlainFixes } from './format'
import { completeCheck } from './providers'
import type { Completer } from './providers'
import { MAX_FAILS, MAX_RECENT_FIXES, clearStatusLine, loadSession, recordToHistoryFile, saveSession, saveStatusLine } from './state'
import type { GrammarCheck, GrammarFix } from './types'

export type CheckOutcome =
  | { skipped: true }
  | {
      skipped: false
      check: GrammarCheck
      markdown?: string
      plain?: string
      historyError?: string
    }

/** Extract checkable user prose or return undefined if disabled, paused, slash command, or too short. */
export const checkableText = (rawInput: string, settings: Settings, lists: Lists, fails: number): string | undefined => {
  if (!settings.enabled || fails >= MAX_FAILS) {
    return undefined
  }
  const text = typedPart(rawInput)
  if (text === '' || text.startsWith('/')) {
    return undefined
  }
  if (!lettersFor(settings.language).test(text) || wordCount(text) < settings.minWords) {
    return undefined
  }
  if (compileSkip(lists.skip).some(re => re.test(text))) {
    return undefined
  }
  return text
}

export type RunCheckParams = {
  rawInput: string
  conversationId: string
  settings: Settings
  lists: Lists
  paths: Paths
  now?: number
  completer?: Completer
}

/** Run one grammar check, update session state and persistent history, and return formatted output. */
export const runPromptCheck = async ({
  rawInput,
  conversationId,
  settings,
  lists,
  paths,
  now = Date.now(),
  completer,
}: RunCheckParams): Promise<CheckOutcome> => {
  const session = loadSession(paths.dataDir, conversationId, now)
  const text = checkableText(rawInput, settings, lists, session.fails)
  if (text === undefined) {
    return { skipped: true }
  }

  const ignore = compileIgnore(lists.ignore)
  const keepHistory = settings.history && lists.history
  const sysPrompt = system({
    natural: settings.natural,
    language: settings.language,
    dialect: settings.dialect,
    showWhy: settings.showWhy,
    kind: keepHistory,
    ignore: ignore.words,
  })

  const failOutcome = (reason: string): CheckOutcome => {
    const nextFails = session.fails + 1
    session.fails = nextFails
    session.lastError = reason
    const check: GrammarCheck = {
      id: now,
      text,
      status: 'error',
      fixes: [],
      error: reason,
      paused: nextFails === MAX_FAILS,
    }
    saveSession(paths.dataDir, conversationId, session, Date.now())
    const paused = check.paused ? `; paused after ${MAX_FAILS} failures in a row, /grammar on to try again` : ''
    const errLine = `! no grammar check: ${reason}${paused}`
    saveStatusLine(paths.dataDir, conversationId, {
      id: String(check.id),
      ansi: ansiError(errLine),
      plain: errLine,
      updatedAt: now,
    })
    return { skipped: false, check, markdown: `*${errLine}*`, plain: errLine }
  }

  const r = await completeCheck(settings, sysPrompt, cut(text, settings.maxChars), settings.timeoutMs, completer)
  if (!r.isAnswered) {
    if (r.gated) {
      return { skipped: true }
    }
    return failOutcome(r.reason)
  }

  try {
    const reply = parseReply(r.text, fallbackFor(settings.language))
    const language = reply === null ? undefined : keptLanguage(settings.language, reply.language)
    if (reply === null || language === undefined) {
      session.fails = 0
      delete session.lastError
      saveSession(paths.dataDir, conversationId, session, Date.now())
      return { skipped: true }
    }
    const fixes: GrammarFix[] = keepFixes(reply.fixes, text, ignore)
    const natural = settings.natural ? usefulNatural(reply.natural, text, fixes, ignore) : null
    const clean = fixes.length === 0 && natural === null
    session.fails = 0
    delete session.lastError
    session.streak = clean ? session.streak + 1 : 0
    if (fixes.length > 0) {
      const tagged = fixes.map(f => ({ ...f, language }))
      session.recentFixes = [...tagged, ...session.recentFixes].slice(0, MAX_RECENT_FIXES)
    }
    const check: GrammarCheck = {
      id: now,
      text,
      status: 'done',
      fixes,
      natural,
      language,
      ...(clean ? { streak: session.streak } : {}),
    }
    saveSession(paths.dataDir, conversationId, session, now)

    let historyError: string | undefined
    if (keepHistory) {
      const saved = recordToHistoryFile(paths.historyFile, fixes, now, language ?? ENGLISH)
      if (!saved.ok) {
        historyError = saved.error
      }
    }

    if (!clean) {
      const plain = `✎ ${plainFixes(fixes, natural, settings.showWhy)}`
      const ansi = ansiFixes(fixes, natural, settings.showWhy)
      const statusPlain = statusLinePlainFixes(fixes, natural, settings.showWhy)
      saveStatusLine(paths.dataDir, conversationId, { id: String(check.id), ansi, plain: statusPlain, updatedAt: now })
      return {
        skipped: false,
        check,
        markdown: markdownFixes(fixes, natural, settings.showWhy),
        plain,
        historyError,
      }
    }

    if (settings.clean) {
      saveStatusLine(paths.dataDir, conversationId, {
        id: String(check.id),
        ansi: ansiClean(session.streak),
        plain: cleanText(session.streak),
        updatedAt: now,
      })
    } else {
      clearStatusLine(paths.dataDir, conversationId, now)
    }

    if (settings.clean && session.streak >= STREAK_FROM) {
      const line = cleanText(session.streak)
      return { skipped: false, check, markdown: `*${line}*`, plain: line, historyError }
    }

    return { skipped: false, check, historyError }
  } catch (err) {
    return failOutcome(err instanceof Error ? err.message : String(err))
  }
}
