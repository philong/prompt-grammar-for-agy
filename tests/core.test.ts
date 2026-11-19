import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BATCH, fallbackFor, keepFixes, parseBatch, parseReply, system, typedPart, usefulNatural } from '../src/check'
import {
  AUTO,
  ENGLISH,
  applyFixes,
  compileIgnore,
  compileSkip,
  cut,
  entriesFrom,
  joinNames,
  keptLanguage,
  languageOf,
  languageSetting,
  loadConfigAndLists,
  mergeLists,
  parseLists,
  resolvePaths,
  settingsFrom,
  wordCount,
  writeGlobalField,
} from '../src/config'
import { ansiClean, ansiError, ansiFixes, markdownFixes, plainFixes, sanitizeTerminalText, statusLinePlainFixes } from '../src/format'
import { buildStatusLineCommand, detectSurface, isPromptGrammarStatusLine } from '../src/statusline'
import { NO_QUIRKS, chatAnswer, chatBody, chatUrl, endpointComplete, hostOf, quirkOf } from '../src/endpoint'
import {
  EMPTY_HISTORY,
  askInput,
  historyText,
  importWindow,
  inLanguage,
  keepable,
  kindOf,
  languagesIn,
  merge,
  pairsOf,
  parseHistory,
  parsePeriod,
  pickLanguage,
  prune,
  record,
  reviewInput,
  splitAsk,
  splitLanguage,
  statsText,
  summaryOf,
  visible,
} from '../src/history'
import { batches, resolveImportPolicy, typedAgyText } from '../src/transcript'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 30, 12)

describe('config', () => {
  test('defaults, env endpoint_key fallback, and display/language normalization', () => {
    const def = settingsFrom({}, {})
    expect(def.display).toBe('reply')
    expect(def.language).toBe(ENGLISH)
    expect(def.endpoint).toBe('')
    expect(def.endpointModel).toBe('')
    expect(def.endpointKey).toBe('')

    expect(settingsFrom({}, { PROMPT_GRAMMAR_ENDPOINT_KEY: 'new-k' }).endpointKey).toBe('new-k')

    const custom = settingsFrom(
      { endpoint: 'http://localhost:11434', endpoint_model: 'qwen2.5:7b', display: 'system', language: 'english, french' },
      {},
    )
    expect(custom.endpoint).toBe('http://localhost:11434')
    expect(custom.endpointModel).toBe('qwen2.5:7b')
    expect(custom.display).toBe('system')
    expect(custom.language).toBe('English, French')

    for (const alias of ['statusline', 'status-line', 'status_line', 'status line']) {
      expect(settingsFrom({ display: alias }, {}).display).toBe('statusline')
    }
  })

  test('loadConfigAndLists blocks project config from overriding endpoint or auth', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prompt-grammar-proj-guard-'))
    try {
      const configDir = join(tmp, 'cfg')
      const repoDir = join(tmp, 'repo')
      mkdirSync(configDir, { recursive: true })
      mkdirSync(join(repoDir, '.agents'), { recursive: true })
      writeFileSync(
        join(repoDir, '.agents', 'grammar.json'),
        JSON.stringify({
          endpoint: 'https://evil.example',
          endpoint_model: 'evil-model',
          endpoint_key: 'repo-key',
          natural: false,
        }),
      )

      const env = { HOME: tmp, PROMPT_GRAMMAR_CONFIG_DIR: configDir, PROMPT_GRAMMAR_ENDPOINT_KEY: 'env-secret' }
      const paths = resolvePaths(repoDir, env)
      const loaded = loadConfigAndLists(paths, env)
      expect(loaded.settings.natural).toBe(false)
      expect(loaded.settings.endpoint).toBe('')
      expect(loaded.settings.endpointModel).toBe('')
      expect(loaded.settings.endpointKey).toBe('env-secret')

      writeFileSync(
        join(configDir, 'grammar.json'),
        JSON.stringify({
          endpoint: 'http://localhost:11434',
          endpoint_model: 'qwen2.5:7b',
          endpoint_key: 'global-key',
        }),
      )
      writeFileSync(
        join(repoDir, '.agents', 'grammar.json'),
        JSON.stringify({
          endpoint: 'https://evil.example',
          endpoint_model: 'evil-model',
          endpoint_key: 'repo-key',
        }),
      )
      const withGlobal = loadConfigAndLists(paths, { HOME: tmp, PROMPT_GRAMMAR_CONFIG_DIR: configDir })
      expect(withGlobal.settings.endpoint).toBe('http://localhost:11434')
      expect(withGlobal.settings.endpointModel).toBe('qwen2.5:7b')
      expect(withGlobal.settings.endpointKey).toBe('global-key')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('writeGlobalField creates grammar.json with 0600 permissions on POSIX', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prompt-grammar-perms-'))
    try {
      const cfgPath = join(tmp, 'cfg', 'grammar.json')
      const res = writeGlobalField(cfgPath, 'endpoint_key', 'secret-token')
      expect(res.ok).toBe(true)
      if (process.platform !== 'win32') {
        expect(statSync(cfgPath).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('detectSurface identifies CLI, IDE, Desktop, Windows paths, and PLUGIN_DATA fallback', () => {
    expect(detectSurface({ transcriptPath: '/home/u/.gemini/antigravity-cli/brain/c1/transcript.jsonl' }, {})).toBe('cli')
    expect(detectSurface({ transcriptPath: '/home/u/.gemini/antigravity-ide/brain/c1/transcript.jsonl' }, {})).toBe('ide')
    expect(detectSurface({ artifactDirectoryPath: '/home/u/.gemini/antigravity/brain/c1' }, {})).toBe('desktop')
    expect(detectSurface({ transcriptPath: 'C:\\Users\\u\\.gemini\\antigravity-ide\\brain\\c1\\t.jsonl' }, {})).toBe('ide')
    expect(detectSurface({ transcriptPath: 'C:\\Users\\u\\.gemini\\antigravity-cli\\brain\\c1\\t.jsonl' }, {})).toBe('cli')
    expect(detectSurface({}, { PLUGIN_DATA: '/home/u/.gemini/antigravity-cli/plugin_data/prompt-grammar' })).toBe('cli')
    expect(detectSurface({ transcriptPath: '/tmp/custom/transcript.jsonl' }, {})).toBe('unknown')
  })

  test('buildStatusLineCommand guards on file existence and isPromptGrammarStatusLine matches unguarded and guarded commands', () => {
    const posixPlain = buildStatusLineCommand('/home/u/.gemini/config/plugins/prompt-grammar/dist/statusline.mjs', 'linux')
    expect(posixPlain).toBe(
      '[ ! -f /home/u/.gemini/config/plugins/prompt-grammar/dist/statusline.mjs ] || exec node /home/u/.gemini/config/plugins/prompt-grammar/dist/statusline.mjs',
    )

    const posixQuoted = buildStatusLineCommand("/home/my user/o'reilly/dist/statusline.mjs", 'linux')
    expect(posixQuoted).toBe(
      "[ ! -f '/home/my user/o'\\''reilly/dist/statusline.mjs' ] || exec node '/home/my user/o'\\''reilly/dist/statusline.mjs'",
    )

    const winPlain = buildStatusLineCommand('C:\\Users\\u\\dist\\statusline.mjs', 'win32')
    expect(winPlain).toBe('if exist C:\\Users\\u\\dist\\statusline.mjs node C:\\Users\\u\\dist\\statusline.mjs')

    const winQuoted = buildStatusLineCommand('C:\\Users\\my user\\dist\\statusline.mjs', 'win32')
    expect(winQuoted).toBe('if exist "C:\\Users\\my user\\dist\\statusline.mjs" node "C:\\Users\\my user\\dist\\statusline.mjs"')

    expect(isPromptGrammarStatusLine(posixPlain)).toBe(true)
    expect(isPromptGrammarStatusLine(winQuoted)).toBe(true)
    expect(isPromptGrammarStatusLine('node /home/u/.gemini/config/plugins/prompt-grammar/dist/statusline.mjs')).toBe(true)
    expect(isPromptGrammarStatusLine('echo custom')).toBe(false)
  })

  test('resolvePaths auto-discovers Antigravity plugin_data when PLUGIN_DATA and CONFIG_DIR are unset', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prompt-grammar-paths-'))
    try {
      const cliData = join(tmp, '.gemini', 'antigravity-cli', 'plugin_data', 'prompt-grammar')
      mkdirSync(cliData, { recursive: true })
      expect(resolvePaths(undefined, { HOME: tmp }).dataDir).toBe(cliData)

      const isolated = resolvePaths(undefined, { HOME: tmp, PROMPT_GRAMMAR_CONFIG_DIR: join(tmp, 'cfg') })
      expect(isolated.dataDir).toBe(join(tmp, 'cfg', 'grammar-data'))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('ANSI formatters colorize fixes/clean/error and sanitize terminal escape sequences', () => {
    expect(sanitizeTerminalText('bad\x1b[31m text\x1b]0;pwn\x07\nhere')).toBe('bad text here')

    const fixes = [
      { from: 'reads\x1b[31m', to: '', why: 'extra word' },
      { from: 'appea\x1b[31m', to: 'appear\n', why: 'typo\x1b]2;evil\x1b\\' },
    ]
    const ansi = ansiFixes(fixes, 'say it\x1b[2J cleanly', true)
    expect(ansi).toContain('\x1b[36m✎\x1b[0m')
    expect(ansi).toContain('\x1b[31;9mreads\x1b[0m \x1b[2m(remove)\x1b[0m \x1b[2m(extra word)\x1b[0m')
    expect(ansi).toContain('\x1b[32mappear\x1b[0m \x1b[2m(typo)\x1b[0m')
    expect(ansi).not.toContain('\x1b[31;9mappea\x1b[0m')
    expect(ansi).not.toMatch(/\bappea\b/)
    expect(ansi).toContain('\x1b[36m↳\x1b[0m \x1b[2;3msay it cleanly\x1b[0m')
    expect(ansi).not.toContain('\x1b]2;')
    expect(ansi).not.toContain('\x1b[2J')

    const ansiNoWhy = ansiFixes(fixes, null, false)
    expect(ansiNoWhy).toBe(
      '\x1b[36m✎\x1b[0m \x1b[31;9mreads\x1b[0m \x1b[2m(remove)\x1b[0m\x1b[2m  ·  \x1b[0m\x1b[32mappear\x1b[0m',
    )

    const statusPlain = statusLinePlainFixes(fixes, 'say it\x1b[2J cleanly', true)
    expect(statusPlain).toBe('✎ reads (remove) (extra word)  ·  appear (typo)\n↳ say it cleanly')
    expect(statusPlain).not.toMatch(/\bappea\b/)

    const md = markdownFixes(
      [
        { from: 'reads', to: '', why: 'extra word' },
        { from: 'appea', to: 'appear', why: 'typo' },
      ],
      'say it cleanly',
      true,
    )
    expect(md).toContain('~~reads~~ *(remove)* *(extra word)*')
    expect(md).toContain('~~appea~~ **appear** *(typo)*')

    const plain = plainFixes(
      [
        { from: 'reads', to: '', why: 'extra word' },
        { from: 'appea', to: 'appear', why: 'typo' },
      ],
      'say it cleanly',
      true,
    )
    expect(plain).toContain('reads → (remove) (extra word)')
    expect(plain).toContain('appea → appear (typo)')

    expect(ansiClean(2)).toBe('\x1b[32m✓ No mistakes\x1b[0m')
    expect(ansiClean(3)).toBe('\x1b[32m✓ No mistakes\x1b[0m\x1b[2m · 3 in a row\x1b[0m')
    expect(ansiError('! fail\x1b[31m\nnow')).toBe('\x1b[2m! fail now\x1b[0m')
  })

  test('language normalization and matching', () => {
    expect(languageOf('brazilian portuguese')).toBe('Brazilian Portuguese')
    expect(languageOf('AUTO')).toBe(AUTO)
    expect(languageSetting('english, French, english')).toBe('English, French')
    expect(languageSetting('French, auto')).toBe(AUTO)
    expect(joinNames(['English', 'French', 'German'])).toBe('English, French or German')
    expect(keptLanguage('English, French', 'American English')).toBe('English')
    expect(keptLanguage('English, French', 'German')).toBeUndefined()
    expect(keptLanguage(AUTO, 'Japanese')).toBe('Japanese')
  })

  test('wordCount handles Latin and CJK/Thai scripts', () => {
    expect(wordCount('ok')).toBe(1)
    expect(wordCount('please deploy it')).toBe(3)
    expect(wordCount('好的')).toBe(1)
    expect(wordCount('请帮我修复这个错误')).toBe(5)
  })

  test('ignore and skip lists compile and match cleanly', () => {
    const lists = mergeLists(parseLists('{"ignore":["kubectl","/^[A-Z]+-\\\\d+$/"],"skip":["^deploy "]}'), {
      ignore: ['kubectl', 'pull request'],
      skip: [],
      history: false,
    })
    expect(lists.history).toBe(false)
    const ignore = compileIgnore(lists.ignore)
    expect(ignore.words).toEqual(['kubectl', 'pull request'])
    expect(ignore.matchers.some(r => r.test('run KUBECTL now'))).toBe(true)
    expect(ignore.matchers.some(r => r.test('PROJ-123'))).toBe(true)

    const skip = compileSkip(lists.skip)
    expect(skip.some(r => r.test('deploy staging'))).toBe(true)
    expect(entriesFrom('pull request, kubectl')).toEqual(['pull request', 'kubectl'])
    expect(cut('one two three four five', 12)).toBe('one two')
    expect(applyFixes('it should appea here', [{ from: 'appea', to: 'appear', why: 'typo' }])).toBe('it should appear here')
  })
})

describe('check', () => {
  test('system prompt and reply parsing', () => {
    const sys = system({ natural: true, language: ENGLISH, dialect: 'us', showWhy: true, kind: true, ignore: ['kubectl'] })
    expect(sys).toContain('American English')
    expect(sys).toContain('"kubectl"')
    expect(sys).toContain('"natural"')

    const reply = parseReply('```json\n{"english": true, "fixes": [{"from": "appea", "to": "appear", "why": "typo", "kind": "spelling"}], "natural": null}\n```')
    expect(reply).toEqual({
      language: 'English',
      fixes: [{ from: 'appea', to: 'appear', why: 'typo', kind: 'spelling' }],
      natural: null,
    })
    expect(parseReply('{"english": false, "fixes": []}')).toBeNull()
    expect(parseReply('{"language": null, "fixes": []}')).toBeNull()
    expect(fallbackFor('French')).toBe('French')
    expect(fallbackFor('English, French')).toBeUndefined()
  })

  test('keepFixes, usefulNatural, and typedPart unwrap <USER_REQUEST>', () => {
    const ignore = compileIgnore(['kubectl'])
    const kept = keepFixes(
      [
        { from: 'appea', to: 'appear', why: 'typo' },
        { from: 'kubectl', to: 'kube', why: 'word' },
        { from: 'ghost', to: 'real', why: 'missing' },
      ],
      'kubectl should appea here',
      ignore,
    )
    expect(kept.map(f => f.from)).toEqual(['appea'])
    expect(usefulNatural('kubectl should appear here', 'kubectl should appea here', kept, ignore)).toBeNull()
    expect(usefulNatural('make kubectl show up here', 'kubectl should appea here', kept, ignore)).toBe('make kubectl show up here')
    expect(usefulNatural('make it show up here', 'kubectl should appea here', kept, ignore)).toBeNull()

    expect(typedPart('<USER_REQUEST>\nfix the bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>')).toBe('fix the bug')
  })

  test('parseBatch handles arrays and lone objects', () => {
    expect(BATCH).toContain('JSON array')
    const m = parseBatch('[{"id":1,"english":true,"fixes":[]},{"id":2,"english":false,"fixes":[]}]')
    expect(m.get(1)).toEqual({ fixes: [], natural: null, language: 'English' })
    expect(m.get(2)).toBeNull()

    const single = parseBatch('{"id":5,"language":"French","fixes":[]}')
    expect(single.get(5)?.language).toBe('French')
  })
})

describe('history', () => {
  test('record, prune, merge, salvage, stats, and periods', () => {
    expect(kindOf('wrong-word')).toBe('wrong word')
    expect(kindOf('unknown_kind')).toBe('other')
    expect(keepable({ from: 'appea', to: 'appear', why: 'typo' })).toBe(true)
    expect(keepable({ from: 'src/app.ts', to: 'src/main.ts', why: 'path' })).toBe(false)
    expect(keepable({ from: 'hello', to: 'Hello', why: 'case' })).toBe(false)

    let h = EMPTY_HISTORY
    h = record(h, [{ from: 'depend from', to: 'depend on', why: 'preposition', kind: 'preposition' }], NOW - 2 * DAY, ENGLISH)
    h = record(h, [{ from: 'depend from', to: 'depend on', why: 'preposition', kind: 'preposition' }], NOW, ENGLISH)
    h = record(h, [{ from: 'le table', to: 'la table', why: 'genre', kind: 'agreement' }], NOW, 'French')

    const text = historyText(h)
    expect(parseHistory(text).fixes.length).toBe(3)
    // Salvage recovers intact lines from truncated history JSON.
    const torn = text.slice(0, text.lastIndexOf('\n', text.length - 5))
    expect(parseHistory(torn).days.length).toBeGreaterThan(0)

    expect(languagesIn(h).map(l => l.lang)).toEqual(['English', 'French'])
    expect(splitLanguage('7d french', ['English', 'French'])).toEqual({ lang: 'French', rest: '7d' })
    expect(pickLanguage(h, undefined, 'English').lang).toBe('English')

    const p = parsePeriod('7d', NOW)
    expect(typeof p).toBe('object')
    if (typeof p !== 'string') {
      const en = inLanguage(h, ENGLISH)
      const s = summaryOf(en, compileIgnore([]), p, NOW)
      expect(s.checked).toBe(2)
      expect(s.top?.count).toBe(2)
      expect(statsText(en, compileIgnore([]), NOW, '/tmp/h.json', true, p)).toContain('depend from → depend on')
    }

    const merged = merge(h, EMPTY_HISTORY, NOW)
    expect(prune(merged, NOW + 100 * DAY).fixes.length).toBe(0)
    expect(pairsOf(visible(h, compileIgnore([]))).length).toBe(2)
    expect(reviewInput(h.fixes)).toContain('2× depend from → depend on')
    expect(importWindow(NOW, 7, '2026-10-28')).toBeDefined()

    const asked = splitAsk('7d why do I miss articles?', NOW)
    expect(typeof asked).toBe('object')
    if (typeof asked !== 'string') {
      expect(asked.question).toBe('why do I miss articles?')
      expect(askInput(h.fixes, asked.period.label, [], [], asked.question)).toContain('Their question: why do I miss articles?')
    }
  })
})

describe('endpoint', () => {
  test('URL normalization, quirk retries, and key redaction', async () => {
    expect(chatUrl('http://localhost:9931')).toBe('http://localhost:9931/v1/chat/completions')
    expect(chatUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(hostOf('https://user:pass@openrouter.ai/api/v1')).toBe('https://openrouter.ai')

    const q1 = quirkOf(NO_QUIRKS, 'Unknown field chat_template_kwargs')
    expect(q1?.thinking).toBe(true)
    expect(chatBody('m', { system: 's', prompt: 'p', maxTokens: 100, timeoutMs: 1000 }, q1)).not.toContain('chat_template_kwargs')
    expect(chatAnswer(200, JSON.stringify({ choices: [{ message: { content: 'hi' } }] })).isAnswered).toBe(true)

    let calls = 0
    const mockFetch = (async () => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: 'unsupported field chat_template_kwargs' } }), { status: 400 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"english":true,"fixes":[]}' } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const res = await endpointComplete('http://localhost:9931', 'gemma', 'secret-token', { system: 's', prompt: 'p', maxTokens: 50, timeoutMs: 5000 }, mockFetch)
    expect(res).toEqual({ isAnswered: true, text: '{"english":true,"fixes":[]}' })
    expect(calls).toBe(2)
  })
})

describe('transcript', () => {
  test('extracts USER_INPUT steps and skips internal prompt-grammar prompts', () => {
    const userLine = JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-10-30T12:00:00Z',
      content: '<USER_REQUEST>\nplease fix this bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>',
    })
    const parsed = typedAgyText(userLine, 'conv-1')
    expect(parsed?.text).toBe('please fix this bug')

    const internalLine = JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-10-30T12:00:00Z',
      content: '<USER_REQUEST>\nFollow the instructions below strictly. Do not call any tools\n</USER_REQUEST>',
    })
    expect(typedAgyText(internalLine, 'conv-2')).toBeUndefined()

    const modelLine = JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-10-30T12:00:01Z', content: 'ok' })
    expect(typedAgyText(modelLine, 'conv-1')).toBeUndefined()

    expect(batches([{ text: 'a' }, { text: 'b' }]).length).toBe(1)
  })

  test('resolveImportPolicy requires configured endpoint for live backfill and permits dry-run', () => {
    const refused = resolveImportPolicy({ endpoint: '' }, { dryRun: false })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error).toContain('/grammar config endpoint')
    }

    const dry = resolveImportPolicy({ endpoint: '' }, { dryRun: true })
    expect(dry).toEqual({ ok: true, parallel: 3, delayMs: 0 })

    const endpoint = resolveImportPolicy({ endpoint: 'http://localhost:8888' }, { dryRun: false, delayMs: 250 })
    expect(endpoint).toEqual({ ok: true, parallel: 3, delayMs: 250 })
  })
})
