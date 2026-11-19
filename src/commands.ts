// Full /grammar command handler (used by PreInvocation interception and standalone CLI).
import { existsSync } from 'node:fs'

import {
  AUTO,
  CONFIG_KEYS,
  compileIgnore,
  cut,
  entriesFrom,
  joinNames,
  languageSetting,
  languagesOf,
  loadConfigAndLists,
  normalizeDisplay,
  parseLists,
  readRawConfig,
  writeGlobalField,
} from './config'
import type { EffectiveDisplayMode, Paths, Settings } from './config'
import { formatAdviceMarkdown, formatReviewMarkdown } from './format'
import {
  ASK_MEMORY,
  ASK_RECENT,
  ASK_SYSTEM,
  KEEP_DAYS,
  MAX_ANSWER,
  MAX_ENTRIES,
  MAX_QUESTION,
  REVIEW_FROM,
  askInput,
  inLanguage,
  languagesIn,
  parsePeriod,
  pickLanguage,
  reviewInput,
  reviewSystem,
  splitAsk,
  splitLanguage,
  statsText,
  summaryOf,
  visible,
  within,
} from './history'
import type { History } from './history'
import { checkerOf, completeCoaching, isProviderReady, modelName } from './providers'
import type { Completer } from './providers'
import { MAX_FAILS, clearHistoryFile, loadSession, readHistoryFile, saveSession } from './state'
import { installStatusLine, isStatusLineActive, statusLineStatus, uninstallStatusLine } from './statusline'

const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
export const languageName = (s: Settings) => (s.language === AUTO ? 'grammar' : joinNames(languagesOf(s.language), 'and'))

export const usage = (s: Settings) =>
  [
    `/grammar help: this list, and what is on now`,
    `/grammar [on|off]: the ${languageName(s)} check of your prompts`,
    `/grammar natural [on|off]: the native-speaker line`,
    `/grammar ignore add <words>: never flag these (phrases: separate with commas)`,
    `/grammar ignore rm <words>: flag them again`,
    `/grammar ignore: the ignore and skip lists, and their files`,
    `/grammar stats [7d|30d|since 2026-10-01] [language]: your most frequent mistakes, from the kept fixes`,
    `/grammar review [7d|30d|since 2026-10-01] [language]: a summary, then advice on them from ${modelName(s)} (one call, from ${REVIEW_FROM} fixes)`,
    `/grammar ask [7d|30d|since 2026-10-01] <question>: ask ${modelName(s)} about your writing, with your fixes at hand (one call)`,
    `/grammar ask list|clear: what follow-ups remember (the last ${ASK_MEMORY} asks and reviews), or forget it`,
    `/grammar ask memory [on|off]: remembering asks for follow-ups`,
    `/grammar history [on|off|clear]: keeping fixes for stats and review`,
    `/grammar statusline [install|uninstall]: configure Antigravity CLI statusLine band (0 ms, ANSI colors)`,
    `/grammar config [key] [value]: view or update settings in ~/.gemini/config/grammar.json`,
  ].join('\n')

const withLanguages = (text: string, h: History) => {
  const all = languagesIn(h)
  return all.length > 1 ? `${text} Languages kept: ${all.map(l => l.lang).join(', ')}.` : text
}

const forLanguage = (h: History, words: string, s: Settings) => {
  const { lang, rest } = splitLanguage(words, languagesIn(h).map(l => l.lang))
  return { ...pickLanguage(h, lang, s.language), rest }
}

const parseConfigValue = (key: string, rawVal: string): { ok: true; value: unknown } | { ok: false; error: string } => {
  const v = rawVal.trim()
  if (v === 'reset' || v === 'default' || v === 'unset') {
    return { ok: true, value: undefined }
  }
  switch (key) {
    case 'enabled':
    case 'natural':
    case 'show_why':
    case 'history':
    case 'clean':
    case 'ask_memory':
      if (v === 'true' || v === 'on') return { ok: true, value: true }
      if (v === 'false' || v === 'off') return { ok: true, value: false }
      return { ok: false, error: `${key} expects true|false or on|off.` }
    case 'dialect':
      if (v === 'any' || v === 'us' || v === 'uk') return { ok: true, value: v }
      return { ok: false, error: `dialect expects any, us, or uk.` }
    case 'display': {
      const mode = normalizeDisplay(v)
      if (mode !== undefined) return { ok: true, value: mode }
      return { ok: false, error: `display expects reply, auto, async, system, statusline, or user_markdown.` }
    }
    case 'min_words': {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 50) return { ok: false, error: `min_words expects an integer 1..50.` }
      return { ok: true, value: n }
    }
    case 'max_chars': {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 200 || n > 20000) return { ok: false, error: `max_chars expects an integer 200..20000.` }
      return { ok: true, value: n }
    }
    case 'timeout_ms': {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 2000 || n > 120000) return { ok: false, error: `timeout_ms expects an integer 2000..120000.` }
      return { ok: true, value: n }
    }
    case 'language': {
      const parsed = languageSetting(v)
      if (parsed === undefined) return { ok: false, error: `Invalid language "${v}".` }
      return { ok: true, value: parsed }
    }
    case 'endpoint':
    case 'endpoint_model':
    case 'endpoint_key':
      return { ok: true, value: v === '""' || v === "''" ? '' : v }
    default:
      return { ok: false, error: `Unknown setting "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}.` }
  }
}

export type CommandContext = {
  args: string
  conversationId: string
  paths: Paths
  now?: number
  completer?: Completer
  env?: Record<string, string | undefined>
  effectiveDisplay?: EffectiveDisplayMode
}

export const runCommand = async ({
  args,
  conversationId,
  paths,
  now = Date.now(),
  completer,
  env = process.env,
  effectiveDisplay,
}: CommandContext): Promise<string> => {
  const { settings: s, lists, projectAllowsHistory } = loadConfigAndLists(paths, env)
  const session = loadSession(paths.dataDir, conversationId, now)
  const trimmed = args.trim()
  const [first = '', ...rest] = trimmed === '' ? [] : trimmed.split(/\s+/)
  const sub = (rest[0] ?? '').toLowerCase()

  const loadHistorySafe = (): { h: History; ignore: ReturnType<typeof compileIgnore> } | string => {
    try {
      const h = readHistoryFile(paths.historyFile)
      return { h, ignore: compileIgnore(lists.ignore) }
    } catch (err) {
      return `${paths.historyFile} does not parse (${err instanceof Error ? err.message : String(err)}). Fix it by hand, or /grammar history clear to start over.`
    }
  }

  const remember = (q: string, a: string) => {
    if (!s.askMemory) {
      return
    }
    session.thread = [...session.thread, { q: cut(q, MAX_QUESTION), a: cut(a, MAX_ANSWER) }].slice(-ASK_MEMORY)
    saveSession(paths.dataDir, conversationId, session, now)
  }

  switch (first.toLowerCase()) {
    case 'help':
    case '?': {
      const paused = session.fails >= MAX_FAILS
      const check = !s.enabled
        ? 'off'
        : paused
          ? `paused after ${MAX_FAILS} failures (/grammar on resumes)${session.lastError ? ` — last error: ${session.lastError}` : ''}`
          : !isProviderReady(s)
            ? 'on, waiting for endpoint (run /grammar config endpoint <url>)'
            : session.fails > 0 && session.lastError
              ? `on (${session.fails} recent failure${session.fails === 1 ? '' : 's'}: ${session.lastError})`
              : 'on'
      const loaded = loadHistorySafe()
      const n = typeof loaded === 'string' ? 0 : visible(loaded.h, loaded.ignore).length
      const displayDesc =
        s.display === 'auto'
          ? `auto (${effectiveDisplay ?? (isStatusLineActive(env) ? 'statusline in CLI, reply in IDE/Desktop' : 'reply')})`
          : s.display
      const status = [
        `Check: ${check}. Natural line: ${s.natural ? 'on' : 'off'}. Display: ${displayDesc}.`,
        `Language: ${s.language === AUTO ? 'auto (each prompt in its own language)' : languagesOf(s.language).length > 1 ? `${s.language} (each prompt in one of them)` : s.language}.`,
        `Model: ${checkerOf(s)}, spelling ${s.dialect}, at least ${s.minWords} words, up to ${s.maxChars} characters.`,
        `History: ${s.history ? 'on' : 'off'}, ${n} fixes kept${n >= REVIEW_FROM ? '' : ` (/grammar review from ${REVIEW_FROM})`}.`,
        s.askMemory
          ? `Ask memory: on, ${plural(session.thread.length, 'exchange')} remembered (/grammar ask list).`
          : 'Ask memory: off.',
      ]
      return `${status.join('\n')}\n\n${usage(s)}`
    }

    case '':
    case 'on':
    case 'off': {
      const want = first.toLowerCase() === 'on' ? true : first.toLowerCase() === 'off' ? false : !s.enabled
      const res = writeGlobalField(paths.globalConfig, 'enabled', want)
      if (!res.ok) {
        return res.error
      }
      if (want) {
        session.fails = 0
        saveSession(paths.dataDir, conversationId, session, now)
      }
      if (!want) {
        return `${capital(languageName(s))} check off.`
      }
      if (!isProviderReady(s)) {
        return `${capital(languageName(s))} check on, waiting for endpoint (run /grammar config endpoint <url>).`
      }
      return `${capital(languageName(s))} check on: ${checkerOf(s)} checks each prompt you send${s.language === AUTO ? ', in its own language' : ''}.`
    }

    case 'natural': {
      if (sub !== '' && sub !== 'on' && sub !== 'off') {
        return usage(s)
      }
      const want = sub === 'on' ? true : sub === 'off' ? false : !s.natural
      const res = writeGlobalField(paths.globalConfig, 'natural', want)
      if (!res.ok) {
        return res.error
      }
      return want
        ? 'Natural phrasing on: the check also says when a native speaker would put it differently.'
        : 'Natural phrasing off: grammar fixes only.'
    }

    case 'ignore': {
      const words = entriesFrom(rest.slice(1).join(' '))
      if (sub === '' || sub === 'list') {
        const files = [paths.globalConfig, paths.projectConfig].filter((p): p is string => p !== undefined)
        const lines: string[] = []
        for (const file of [...new Set(files)]) {
          const parsed = readRawConfig(file)
          const l = parsed.error === undefined ? parseLists(JSON.stringify(parsed.raw)) : { ignore: [], skip: [], history: true }
          lines.push(
            `${file}\n  ignore: ${l.ignore.length > 0 ? l.ignore.join(', ') : 'none'}\n  skip: ${l.skip.length > 0 ? l.skip.join(', ') : 'none'}`,
          )
        }
        return lines.join('\n')
      }
      if ((sub === 'add' || sub === 'rm') && words.length > 0) {
        const existing = readRawConfig(paths.globalConfig)
        if (existing.error !== undefined) {
          return `${paths.globalConfig} does not parse (${existing.error}), so it was left as it is. Fix it by hand.`
        }
        const current = parseLists(JSON.stringify(existing.raw)).ignore
        const lower = new Set(words.map(w => w.toLowerCase()))
        const next = sub === 'add' ? [...new Set([...current, ...words])] : current.filter(w => !lower.has(w.toLowerCase()))
        const res = writeGlobalField(paths.globalConfig, 'ignore', next)
        if (!res.ok) {
          return res.error
        }
        const list = words.map(w => JSON.stringify(w)).join(', ')
        return sub === 'add'
          ? `Never flagged now: ${list}. Kept in ${paths.globalConfig}.`
          : `Flagged again: ${list}. Kept in ${paths.globalConfig}.`
      }
      return usage(s)
    }

    case 'stats': {
      const loaded = loadHistorySafe()
      if (typeof loaded === 'string') {
        return loaded
      }
      const words = rest.join(' ')
      const picked = forLanguage(loaded.h, words, s)
      const period = parsePeriod(picked.rest, now)
      if (typeof period === 'string') {
        return withLanguages(period, loaded.h)
      }
      const others = picked.others
        .map(o => ({ lang: o.lang, fixes: visible(within(inLanguage(loaded.h, o.lang), period), loaded.ignore).length }))
        .filter(o => o.fixes > 0)
      const h = loaded.h.fixes.length + loaded.h.days.length === 0 ? loaded.h : inLanguage(loaded.h, picked.lang)
      const language = picked.show ? picked.lang : undefined
      return statsText(
        h,
        loaded.ignore,
        now,
        paths.historyFile,
        s.history,
        period,
        words,
        modelName(s),
        language,
        others,
      )
    }

    case 'review': {
      const loaded = loadHistorySafe()
      if (typeof loaded === 'string') {
        return loaded
      }
      const words = rest.join(' ')
      const picked = forLanguage(loaded.h, words, s)
      const period = parsePeriod(picked.rest, now)
      if (typeof period === 'string') {
        return withLanguages(period, loaded.h)
      }
      const h = inLanguage(loaded.h, picked.lang)
      const fixes = visible(within(h, period), loaded.ignore)
      if (fixes.length < REVIEW_FROM) {
        const longer = period.before === undefined ? '' : ' Try a longer period.'
        const where = picked.show ? ` in ${picked.lang}` : ''
        return `Not enough to go on yet: ${fixes.length} fixes kept${where} for ${period.label}, the review starts at ${REVIEW_FROM}.${longer} /grammar stats shows them so far.`
      }
      const summary = summaryOf(h, loaded.ignore, period, now, picked.show ? picked.lang : undefined)
      const r = await completeCoaching(s, reviewSystem(picked.lang), reviewInput(fixes), 8000, 180000, completer)
      if ('refused' in r) {
        return `No review: ${r.refused}`
      }
      remember(`/grammar review ${words}`.trim(), r.text)
      return formatReviewMarkdown(summary, r.text, r.model, s.askMemory)
    }

    case 'ask': {
      const rawTail = trimmed.slice(first.length).trim()
      const lower = rawTail.toLowerCase()
      const askList = () => {
        if (!s.askMemory) {
          return 'Ask memory: off. Each /grammar ask starts fresh. /grammar ask memory on remembers asks for follow-ups.'
        }
        if (session.thread.length === 0) {
          return `Ask memory: on, nothing remembered yet. Each /grammar ask and /grammar review is remembered for follow-ups, the last ${ASK_MEMORY}.`
        }
        const short = (t: string) => {
          const line = t.replace(/\s+/g, ' ').trim()
          return line.length > 90 ? `${cut(line, 90)}…` : line
        }
        return [
          `Ask memory: on. Follow-ups remember ${plural(session.thread.length, 'exchange')}, oldest first (the last ${ASK_MEMORY} are kept):`,
          ...session.thread.map((t, i) => `${i + 1}. ${short(t.q)}\n   ${short(t.a)}`),
          '/grammar ask clear forgets them; /grammar ask memory off stops remembering. Gone when the session ends.',
        ].join('\n')
      }

      if (lower === '' || lower === 'help') {
        const how = `/grammar ask [7d|30d|since 2026-10-01] <question>: ask ${modelName(s)} about your writing, with your kept fixes at hand.\n/grammar ask list|clear, /grammar ask memory on|off.`
        return `${how}\n\n${askList()}`
      }
      if (lower === 'list') {
        return askList()
      }
      if (lower === 'clear') {
        const n = session.thread.length
        session.thread = []
        saveSession(paths.dataDir, conversationId, session, now)
        return n === 0 ? 'Nothing remembered, nothing to forget.' : `Forgot ${plural(n, 'exchange')}: the next /grammar ask starts fresh.`
      }
      const mem = /^memory(?:\s+(on|off))?$/.exec(lower)
      if (mem !== null) {
        const want = mem[1] === 'on' ? true : mem[1] === 'off' ? false : !s.askMemory
        const res = writeGlobalField(paths.globalConfig, 'ask_memory', want)
        if (!res.ok) {
          return res.error
        }
        const n = session.thread.length
        if (!want && n > 0) {
          session.thread = []
          saveSession(paths.dataDir, conversationId, session, now)
        }
        return want
          ? `Ask memory on: follow-ups remember the last ${ASK_MEMORY} asks and reviews of the session. /grammar ask list shows them.`
          : `Ask memory off: each /grammar ask starts fresh${n > 0 ? `, and the ${plural(n, 'remembered exchange')} ${n === 1 ? 'is' : 'are'} forgotten` : ''}.`
      }

      const split = splitAsk(rawTail, now)
      if (typeof split === 'string') {
        return split
      }
      if (split.question === '') {
        return 'Ask what? /grammar ask 7d which prepositions do I mix up?'
      }
      const question = cut(split.question, MAX_QUESTION)
      const loaded = loadHistorySafe()
      const fixes = typeof loaded === 'string' ? [] : visible(within(loaded.h, split.period), loaded.ignore)
      const recent = session.recentFixes.slice(0, ASK_RECENT)
      const turns = s.askMemory ? session.thread : []
      const r = await completeCoaching(
        s,
        ASK_SYSTEM,
        askInput(fixes, split.period.label, recent, turns, question),
        4000,
        120000,
        completer,
      )
      if ('refused' in r) {
        return `No answer: ${r.refused}`
      }
      remember(question, r.text)
      const memoryNote = !s.askMemory
        ? 'memory off, each ask starts fresh'
        : turns.length === 0
          ? 'follow-ups remember this · /grammar ask clear forgets'
          : `remembered ${turns.length} earlier · /grammar ask list, clear`
      const footer = `${r.model}, from ${plural(fixes.length, 'fix', 'fixes')} · ${memoryNote}`
      return `${formatAdviceMarkdown(r.text)}\n\n*${footer}*`
    }

    case 'history': {
      if (sub === 'clear') {
        if (!existsSync(paths.historyFile)) {
          return 'Nothing kept, nothing to clear.'
        }
        clearHistoryFile(paths.historyFile)
        return `Cleared: ${paths.historyFile} holds no fixes now.`
      }
      if (sub === 'on' || sub === 'off') {
        const want = sub === 'on'
        const res = writeGlobalField(paths.globalConfig, 'history', want)
        if (!res.ok) {
          return res.error
        }
        return want
          ? `History on: each fix is kept in ${paths.historyFile} for /grammar stats and /grammar review.`
          : `History off: no new fixes are kept. What ${paths.historyFile} holds stays; /grammar history clear empties it.`
      }
      if (sub !== '') {
        return usage(s)
      }
      const loaded = loadHistorySafe()
      if (typeof loaded === 'string') {
        return `History: ${s.history ? 'on' : 'off'}. ${loaded}`
      }
      return [
        `History: ${s.history ? 'on' : 'off'}${s.history && !projectAllowsHistory ? ', but off in this project (its .agents/grammar.json says "history": false)' : ''}.`,
        `${visible(loaded.h, loaded.ignore).length} fixes kept in ${paths.historyFile}: the last ${KEEP_DAYS} days, up to ${MAX_ENTRIES}.`,
        '/grammar history on|off switches it; /grammar history clear empties the file.',
      ].join('\n')
    }

    case 'statusline': {
      if (sub === '' || sub === 'status') {
        return statusLineStatus(paths, env)
      }
      if (sub === 'install') {
        return installStatusLine(paths, env, { force: rest.slice(1).includes('--force') })
      }
      if (sub === 'uninstall' || sub === 'remove' || sub === 'off') {
        return uninstallStatusLine(paths, env)
      }
      return usage(s)
    }

    case 'config': {
      if (rest.length === 0) {
        return [
          `Config file: ${paths.globalConfig}`,
          ...(paths.projectConfig && existsSync(paths.projectConfig) ? [`Project file: ${paths.projectConfig}`] : []),
          `enabled: ${s.enabled}`,
          `natural: ${s.natural}`,
          `language: ${s.language}`,
          `dialect: ${s.dialect}`,
          `min_words: ${s.minWords}`,
          `max_chars: ${s.maxChars}`,
          `show_why: ${s.showWhy}`,
          `history: ${s.history}`,
          `clean: ${s.clean}`,
          `ask_memory: ${s.askMemory}`,
          `display: ${s.display}`,
          `timeout_ms: ${s.timeoutMs}`,
          `endpoint: ${s.endpoint || '(none)'}`,
          `endpoint_model: ${s.endpointModel || '(default)'}`,
          `endpoint_key: ${s.endpointKey ? '(set)' : '(none)'}`,
          '',
          `Set with: /grammar config <key> <value> (or \`unset\` to reset).`,
        ].join('\n')
      }
      const key = (rest[0] ?? '').toLowerCase()
      const rawVal = rest.slice(1).join(' ')
      if (rawVal === '') {
        return `Usage: /grammar config <key> <value>. Valid keys: ${CONFIG_KEYS.join(', ')}.`
      }
      const parsed = parseConfigValue(key, rawVal)
      if (!parsed.ok) {
        return parsed.error
      }
      const res = writeGlobalField(paths.globalConfig, key, parsed.value)
      if (!res.ok) {
        return res.error
      }
      const shown = key === 'endpoint_key' && parsed.value ? '***' : parsed.value === undefined ? '(default)' : String(parsed.value)
      let hint = ''
      if (key === 'display' && parsed.value === 'statusline' && !isStatusLineActive(env)) {
        hint = '\nRun /grammar statusline install to configure Antigravity CLI statusLine.'
      }
      return `Updated ${key} = ${shown} in ${paths.globalConfig}.${hint}`
    }

    default:
      return usage(s)
  }
}
