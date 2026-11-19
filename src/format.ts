// Markdown & plain-text formatters for grammar fixes, streaks, reviews, asks, and hook injections.
import type { Summary } from './history'
import type { AgyHookOutput, GrammarFix } from './types'

export const STREAK_FROM = 3
const CHECK = '✓'
const LOGO = '✎'
const NATURAL = '↳'

/** Plain-text fixes and optional native-speaker line. */
export const plainFixes = (fixes: readonly GrammarFix[], natural: string | null, showWhy: boolean) => {
  const list = fixes.map(f => `${f.from} → ${f.to === '' ? '(remove)' : f.to}${showWhy && f.why !== '' ? ` (${f.why})` : ''}`)
  return `${list.join('  ·  ')}${natural === null ? '' : `${list.length > 0 ? '\n' : ''}${NATURAL} ${natural}`}`
}

/** Markdown-formatted fixes (`~~from~~ **to** *(why)*`) and optional native-speaker line. */
export const markdownFixes = (fixes: readonly GrammarFix[], natural: string | null, showWhy: boolean) => {
  const list = fixes.map(f => {
    const fixed = f.to === '' ? '*(remove)*' : `**${f.to}**`
    const why = showWhy && f.why !== '' ? ` *(${f.why})*` : ''
    return `~~${f.from}~~ ${fixed}${why}`
  })
  const lines: string[] = []
  if (list.length > 0) {
    lines.push(`${LOGO} ${list.join('  ·  ')}`)
  }
  if (natural !== null) {
    lines.push(`${NATURAL} *${natural}*`)
  }
  return lines.join('\n')
}

/** Clean prompt streak line (shown starting at STREAK_FROM). */
export const cleanText = (n: number) => `${CHECK} no mistakes${n >= STREAK_FROM ? ` · ${n} in a row` : ''}`

/** Strip ANSI CSI/OSC escape sequences and ASCII control characters for safe terminal rendering. */
export const sanitizeTerminalText = (text: string): string =>
  text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** ANSI-colored statusline fixes (cyan pencil, correction only in green for replacements, red strikethrough + dim `(remove)` for deletions, dim reason) and optional italic natural line. */
export const ansiFixes = (fixes: readonly GrammarFix[], natural: string | null, showWhy: boolean): string => {
  const list = fixes.map(f => {
    const from = sanitizeTerminalText(f.from)
    const to = sanitizeTerminalText(f.to)
    const why = sanitizeTerminalText(f.why)
    const reason = showWhy && why !== '' ? ` \x1b[2m(${why})\x1b[0m` : ''
    return to === ''
      ? `\x1b[31;9m${from}\x1b[0m \x1b[2m(remove)\x1b[0m${reason}`
      : `\x1b[32m${to}\x1b[0m${reason}`
  })
  const lines: string[] = []
  if (list.length > 0) {
    lines.push(`\x1b[36m${LOGO}\x1b[0m ${list.join('\x1b[2m  ·  \x1b[0m')}`)
  }
  if (natural !== null) {
    const nat = sanitizeTerminalText(natural)
    if (nat !== '') {
      lines.push(`\x1b[36m${NATURAL}\x1b[0m \x1b[2;3m${nat}\x1b[0m`)
    }
  }
  return lines.join('\n')
}

/** Compact plain-text statusline fixes (for `NO_COLOR`): correction only for replacements, `from (remove)` for removals. */
export const statusLinePlainFixes = (fixes: readonly GrammarFix[], natural: string | null, showWhy: boolean): string => {
  const list = fixes.map(f => {
    const from = sanitizeTerminalText(f.from)
    const to = sanitizeTerminalText(f.to)
    const why = sanitizeTerminalText(f.why)
    const reason = showWhy && why !== '' ? ` (${why})` : ''
    return to === '' ? `${from} (remove)${reason}` : `${to}${reason}`
  })
  const lines: string[] = []
  if (list.length > 0) {
    lines.push(`${LOGO} ${list.join('  ·  ')}`)
  }
  if (natural !== null) {
    const nat = sanitizeTerminalText(natural)
    if (nat !== '') {
      lines.push(`${NATURAL} ${nat}`)
    }
  }
  return lines.join('\n')
}

/** ANSI-colored clean prompt indicator for the CLI status line. */
export const ansiClean = (n: number): string =>
  `\x1b[32m${CHECK} No mistakes\x1b[0m${n >= STREAK_FROM ? `\x1b[2m · ${n} in a row\x1b[0m` : ''}`

/** Dim ANSI error line for the CLI status line. */
export const ansiError = (errorLine: string): string => `\x1b[2m${sanitizeTerminalText(errorLine)}\x1b[0m`

/** Instruction injected in `display: "reply"` mode so the agent appends the fixes verbatim at the end of its reply. */
export const replyNote = (lines: string) =>
  `The grammar plugin checked the user's prompt above. End your reply with a blank line followed by the exact lines below, untouched, and say nothing else about them:

${lines}

Otherwise answer the user's message normally.`

/** Instruction injected when /grammar <subcommand> was already computed deterministically in PreInvocation. */
export const verbatimCommandNote = (command: string, output: string) =>
  `The user ran \`${command}\`, which the prompt-grammar plugin already executed locally. Reply with ONLY the exact output below verbatim, without calling any tools, modifying it, or adding any extra text:

${output}`

/** Format model advice or ask text, rendering `  wrong → right` example lines as `~~wrong~~ **right**`. */
export const formatAdviceMarkdown = (text: string) =>
  text
    .split('\n')
    .map(line => {
      const m = /^\s*(.+?)\s+→\s+(.*?)\s*$/.exec(line)
      if (m !== null) {
        const from = m[1] ?? ''
        const to = m[2] ?? ''
        return `  - ~~${from}~~ **${to === '' ? '(drop it)' : to}**`
      }
      return line
    })
    .join('\n')

/** Format a /grammar review summary card + advice in clean Markdown. */
export const formatReviewMarkdown = (m: Summary, advice: string, model: string, followUp: boolean) => {
  const pct = (n: number, of: number) => `${Math.round((100 * n) / Math.max(1, of))}%`
  const BAR = 15
  const most = Math.max(1, ...m.kinds.map(k => k.n))
  const width = Math.max(0, ...m.kinds.slice(0, 3).map(k => k.kind.length))

  const cardLines = [
    `Grammar review · ${m.language === undefined ? '' : `${m.language} · `}${m.label} (${m.range})`,
    `${m.checked} prompts · ${pct(m.withFixes, m.checked)} with a fix · ${m.fixes} fixes`,
  ]
  if (m.trend !== undefined) {
    const arrow = m.trend.fewer === true ? '↓' : m.trend.fewer === false ? '↑' : '='
    cardLines.push(`${arrow} ${m.trend.text}`)
  }
  if (m.kinds.length > 0) {
    cardLines.push('')
    for (const k of m.kinds.slice(0, 3)) {
      const n = Math.max(1, Math.round((BAR * k.n) / most))
      cardLines.push(`${k.kind.padEnd(width)}  ${'█'.repeat(n)}${'░'.repeat(BAR - n)}  ${Math.round(k.share * 100)}%`)
    }
  }
  if (m.top !== undefined) {
    cardLines.push('', `most repeated: ${m.top.from} → ${m.top.to === '' ? '(drop it)' : m.top.to}  ×${m.top.count}`)
  }

  const hint = followUp ? ' · `/grammar ask <question>` follows up' : ''
  return [
    '```text',
    ...cardLines,
    '```',
    '',
    formatAdviceMarkdown(advice),
    '',
    `*${model}, from ${m.fixes} fixes${hint}*`,
  ].join('\n')
}

/** Build a hook output injecting a plain systemMessage (works across all agy versions). */
export const injectSystemMessage = (text: string): AgyHookOutput => ({
  injectSteps: [{ systemMessage: { systemMessage: text } }],
})

/** Build a hook output injecting hidden user_markdown (requires agy with metadata.user_markdown support). */
export const injectUserMarkdown = (markdown: string, terminate = false): AgyHookOutput => ({
  injectSteps: [{ systemMessage: { systemMessage: '', metadata: { user_markdown: markdown } } }],
  ...(terminate ? { terminationBehavior: 'terminate' } : {}),
})
