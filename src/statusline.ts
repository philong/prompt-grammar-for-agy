// Renderer and settings.json install/uninstall helpers for Antigravity CLI `statusLine` (`display: "statusline"`).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfigAndLists, resolvePaths, writeGlobalField } from './config'
import type { DisplayMode, EffectiveDisplayMode, Paths } from './config'
import { sanitizeTerminalText } from './format'
import { readStatusLine } from './state'
import type { AgyHookInput } from './types'

export type AgySurface = 'cli' | 'ide' | 'desktop' | 'unknown'

export type AgyStatusLineInput = {
  conversation_id?: string
  conversationId?: string
  session_id?: string
  sessionId?: string
  cwd?: string
  workspace?: { current_dir?: string; project_dir?: string }
  agent_state?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

const homeOf = (env: Record<string, string | undefined>) => (env.HOME ?? env.USERPROFILE ?? homedir()).replace(/[\\/]+$/, '')

const defaultScriptDir = () => {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return undefined
  }
}

/** Render the active status line string for `payload`, or `''` when disabled / not in `statusline` mode / nothing cached. */
export const renderStatusLine = (
  payload: AgyStatusLineInput,
  opts?: { env?: Record<string, string | undefined> },
): string => {
  const env = opts?.env ?? process.env
  const conversationId = (
    payload.conversation_id ||
    payload.conversationId ||
    payload.session_id ||
    payload.sessionId ||
    ''
  ).trim()
  if (conversationId === '') {
    return ''
  }

  const cwd = payload.cwd || payload.workspace?.current_dir || payload.workspace?.project_dir
  const paths = resolvePaths(cwd, env)
  const { settings } = loadConfigAndLists(paths, env)
  if (!settings.enabled || (settings.display !== 'statusline' && settings.display !== 'auto')) {
    return ''
  }

  const entry = readStatusLine(paths.dataDir, conversationId)
  if (entry === undefined) {
    return ''
  }

  if (env.NO_COLOR) {
    return entry.plain
      .split('\n')
      .map(sanitizeTerminalText)
      .filter(Boolean)
      .join('\n')
  }
  return entry.ansi
}

/** Resolve the Antigravity CLI settings.json path (`AGY_CLI_SETTINGS` override or `~/.gemini/antigravity-cli/settings.json`). */
export const resolveAgySettingsPath = (env: Record<string, string | undefined> = process.env): string => {
  const override = env.AGY_CLI_SETTINGS?.trim()
  if (override) {
    return override
  }
  return join(homeOf(env), '.gemini', 'antigravity-cli', 'settings.json')
}

/** Resolve the path to `dist/statusline.mjs` for `statusLine.command`. */
export const resolveStatusLineScriptPath = (
  env: Record<string, string | undefined> = process.env,
  scriptDir: string | undefined = defaultScriptDir(),
): string => {
  const pluginRoot = env.PLUGIN_ROOT?.trim()
  if (pluginRoot) {
    return join(pluginRoot.replace(/[\\/]+$/, ''), 'dist', 'statusline.mjs')
  }
  if (scriptDir) {
    const sibling = join(scriptDir, 'statusline.mjs')
    if (existsSync(sibling)) {
      return sibling
    }
  }
  return join(homeOf(env), '.gemini', 'config', 'plugins', 'prompt-grammar', 'dist', 'statusline.mjs')
}

/** Format a shell command string invoking `node` on `scriptPath`, exiting 0 silently if the script was uninstalled. */
export const buildStatusLineCommand = (scriptPath: string, platform: NodeJS.Platform = process.platform): string => {
  if (platform === 'win32') {
    const target = /[\s"&|<>^()]/.test(scriptPath) ? `"${scriptPath.replace(/"/g, '\\"')}"` : scriptPath
    return `if exist ${target} node ${target}`
  }
  const target = /^[a-zA-Z0-9._/@:-]+$/.test(scriptPath) ? scriptPath : `'${scriptPath.replace(/'/g, "'\\''")}'`
  return `[ ! -f ${target} ] || exec node ${target}`
}

/** True when `cmd` points at prompt-grammar's `statusline.mjs`. */
export const isPromptGrammarStatusLine = (cmd: unknown): boolean =>
  typeof cmd === 'string' && /prompt-grammar.*statusline\.mjs|statusline\.mjs/.test(cmd)

/** Detect the running Antigravity surface (`cli`, `ide`, `desktop`, or `unknown`) from hook paths / `$PLUGIN_DATA`. */
export const detectSurface = (
  payload: Pick<AgyHookInput, 'transcriptPath' | 'artifactDirectoryPath'>,
  env: Record<string, string | undefined> = process.env,
): AgySurface => {
  for (const candidate of [payload.transcriptPath, payload.artifactDirectoryPath, env.PLUGIN_DATA]) {
    if (!candidate) {
      continue
    }
    if (/(?:^|[\\/])antigravity-cli(?:[\\/]|$)/i.test(candidate)) {
      return 'cli'
    }
    if (/(?:^|[\\/])antigravity-ide(?:[\\/]|$)/i.test(candidate)) {
      return 'ide'
    }
    if (/(?:^|[\\/])antigravity(?:[\\/]|$)/i.test(candidate)) {
      return 'desktop'
    }
  }
  return 'unknown'
}

const readAgySettings = (
  settingsPath: string,
): { exists: boolean; raw: Record<string, unknown>; error?: string } => {
  if (!existsSync(settingsPath)) {
    return { exists: false, raw: {} }
  }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown
    if (!isRecord(parsed)) {
      return { exists: true, raw: {}, error: 'not a JSON object' }
    }
    return { exists: true, raw: parsed }
  } catch (err) {
    return { exists: true, raw: {}, error: err instanceof Error ? err.message : String(err) }
  }
}

/** True when `prompt-grammar` statusLine is configured and enabled in Antigravity CLI `settings.json`. */
export const isStatusLineActive = (env: Record<string, string | undefined> = process.env): boolean => {
  const parsed = readAgySettings(resolveAgySettingsPath(env))
  if (parsed.error !== undefined) {
    return false
  }
  const sl = isRecord(parsed.raw.statusLine) ? parsed.raw.statusLine : undefined
  if (sl === undefined || sl.enabled === false) {
    return false
  }
  return isPromptGrammarStatusLine(sl.command)
}

/** Resolve `display: "auto"` to the concrete surface mode (`statusline` in CLI when installed, else `reply`). */
export const resolveEffectiveDisplay = (
  display: DisplayMode,
  payload: Pick<AgyHookInput, 'transcriptPath' | 'artifactDirectoryPath'>,
  env: Record<string, string | undefined> = process.env,
): EffectiveDisplayMode => {
  if (display !== 'auto') {
    return display
  }
  return detectSurface(payload, env) === 'cli' && isStatusLineActive(env) ? 'statusline' : 'reply'
}

const writeSettingsAtomic = (settingsPath: string, obj: Record<string, unknown>) => {
  let mode = 0o600
  if (existsSync(settingsPath)) {
    try {
      mode = statSync(settingsPath).mode & 0o777
    } catch {
      // Keep default 0o600.
    }
  }
  mkdirSync(dirname(settingsPath), { recursive: true })
  const tmp = `${settingsPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { encoding: 'utf8', mode })
  try {
    chmodSync(tmp, mode)
  } catch {
    // Best-effort mode preservation.
  }
  renameSync(tmp, settingsPath)
}

/** Describe current `display` mode and Antigravity CLI `statusLine` installation status. */
export const statusLineStatus = (
  paths: Paths,
  env: Record<string, string | undefined> = process.env,
  opts?: { scriptDir?: string },
): string => {
  const { settings } = loadConfigAndLists(paths, env)
  const settingsPath = resolveAgySettingsPath(env)
  const parsed = readAgySettings(settingsPath)
  const scriptPath = resolveStatusLineScriptPath(env, opts?.scriptDir)

  const displayLine =
    settings.display === 'auto'
      ? 'Display: auto (statusline in CLI when installed, reply in IDE/Desktop)'
      : `Display: ${settings.display}`
  const lines = [displayLine, `Settings file: ${settingsPath}`]
  if (parsed.error !== undefined) {
    lines.push(`Status line: unreadable (${parsed.error})`)
    return lines.join('\n')
  }

  const sl = isRecord(parsed.raw.statusLine) ? parsed.raw.statusLine : undefined
  const cmd = typeof sl?.command === 'string' ? sl.command.trim() : ''
  if (cmd === '') {
    lines.push('Status line: not installed.')
    lines.push(`Run /grammar statusline install to configure ${scriptPath}.`)
  } else if (isPromptGrammarStatusLine(cmd)) {
    const enabled = sl?.enabled !== false
    const stacked = sl?.stack_with_default === true
    lines.push(`Status line: installed (${enabled ? 'enabled' : 'disabled'}, stack_with_default: ${stacked}).`)
    lines.push(`Command: ${cmd}`)
    if (settings.display !== 'statusline' && settings.display !== 'auto') {
      lines.push('Note: display is currently not "auto" or "statusline"; run /grammar config display auto to activate.')
    }
  } else {
    lines.push(`Status line: another command is configured (${cmd}).`)
    lines.push('Run /grammar statusline install --force to replace it with prompt-grammar.')
  }
  return lines.join('\n')
}

/** Install `statusLine` in Antigravity CLI `settings.json` and set `display = statusline`. */
export const installStatusLine = (
  paths: Paths,
  env: Record<string, string | undefined> = process.env,
  opts?: { force?: boolean; scriptDir?: string },
): string => {
  const settingsPath = resolveAgySettingsPath(env)
  const parsed = readAgySettings(settingsPath)
  if (parsed.error !== undefined) {
    return `${settingsPath} does not parse (${parsed.error}), so it was left untouched. Fix it by hand.`
  }

  const existingSl = isRecord(parsed.raw.statusLine) ? parsed.raw.statusLine : undefined
  const existingCmd = typeof existingSl?.command === 'string' ? existingSl.command.trim() : ''
  const scriptPath = resolveStatusLineScriptPath(env, opts?.scriptDir)
  const command = buildStatusLineCommand(scriptPath)

  if (existingCmd !== '' && !isPromptGrammarStatusLine(existingCmd) && !opts?.force) {
    return [
      `${settingsPath} already configures another statusLine command: ${existingCmd}`,
      'Run /grammar statusline install --force to overwrite it, or merge manually:',
      JSON.stringify(
        { statusLine: { type: 'command', command, stack_with_default: true, padding: 0, enabled: true } },
        null,
        2,
      ),
    ].join('\n')
  }

  const displayRes = writeGlobalField(paths.globalConfig, 'display', 'auto')
  if (!displayRes.ok) {
    return displayRes.error
  }

  const nextSettings: Record<string, unknown> = {
    ...parsed.raw,
    statusLine: {
      type: 'command',
      command,
      stack_with_default: true,
      padding: 0,
      enabled: true,
    },
  }
  writeSettingsAtomic(settingsPath, nextSettings)

  return [
    `Installed prompt-grammar statusLine in ${settingsPath} (stack_with_default: true).`,
    `Updated display = auto in ${paths.globalConfig} (statusline in CLI, reply in IDE/Desktop).`,
    `Command: ${command}`,
  ].join('\n')
}

/** Remove prompt-grammar's `statusLine` from `settings.json` (if owned by prompt-grammar) and reset `statusline`/`auto` display back to `reply`. */
export const uninstallStatusLine = (
  paths: Paths,
  env: Record<string, string | undefined> = process.env,
): string => {
  const settingsPath = resolveAgySettingsPath(env)
  const parsed = readAgySettings(settingsPath)
  const { settings } = loadConfigAndLists(paths, env)
  const notes: string[] = []

  if (!parsed.exists) {
    notes.push(`${settingsPath} not found; nothing to remove there.`)
  } else if (parsed.error !== undefined) {
    return `${settingsPath} does not parse (${parsed.error}), so it was left untouched.`
  } else {
    const existingSl = isRecord(parsed.raw.statusLine) ? parsed.raw.statusLine : undefined
    const existingCmd = typeof existingSl?.command === 'string' ? existingSl.command.trim() : ''
    if (existingCmd !== '' && isPromptGrammarStatusLine(existingCmd)) {
      const nextSettings: Record<string, unknown> = {
        ...parsed.raw,
        statusLine: {
          type: '',
          command: '',
          enabled: true,
        },
      }
      writeSettingsAtomic(settingsPath, nextSettings)
      notes.push(`Removed prompt-grammar statusLine from ${settingsPath}.`)
    } else if (existingCmd !== '') {
      notes.push(`Left ${settingsPath} untouched (statusLine is configured by another command: ${existingCmd}).`)
    } else {
      notes.push(`No prompt-grammar statusLine configured in ${settingsPath}.`)
    }
  }

  if (settings.display === 'statusline' || settings.display === 'auto') {
    const displayRes = writeGlobalField(paths.globalConfig, 'display', 'reply')
    if (!displayRes.ok) {
      return `${notes.join('\n')}\n${displayRes.error}`
    }
    notes.push(`Reset display = reply in ${paths.globalConfig}.`)
  }

  return notes.join('\n')
}
