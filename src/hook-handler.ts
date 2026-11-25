// Pure testable Antigravity hook dispatcher (SessionStart, PreInvocation, PostInvocation).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { typedPart } from './check'
import { runCommand } from './commands'
import { loadConfigAndLists, resolvePaths } from './config'
import { injectSystemMessage, injectUserMarkdown, replyNote, verbatimCommandNote } from './format'
import { INTERNAL_ENV, isProviderReady } from './providers'
import type { Completer } from './providers'
import { checkableText, runPromptCheck } from './runner'
import { clearInflight, drainPending, loadSession, markHistoryAnnounced, pruneStaleSessions, readInflight, readMeta, readStatusLine, saveInflight } from './state'
import { resolveEffectiveDisplay } from './statusline'
import type { AgyHookInput, AgyHookOutput } from './types'

export type HandleHookOptions = {
  env?: Record<string, string | undefined>
  now?: number
  completer?: Completer
  spawnWorker?: (workerScript: string, jobJson: string) => number | undefined | void
  pollIntervalMs?: number
  isPidAlive?: (pid: number) => boolean
}

const defaultSpawnWorker = (workerScript: string, jobJson: string): number | undefined => {
  const child = spawn(process.execPath, [workerScript], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, [INTERNAL_ENV]: '1', PROMPT_GRAMMAR_JOB: jobJson },
  })
  child.unref()
  return child.pid
}

const defaultIsPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const waitForInflightStatusLine = async (
  dataDir: string,
  conversationId: string,
  timeoutMs: number,
  opts: { pollIntervalMs?: number; isPidAlive?: (pid: number) => boolean } = {},
): Promise<void> => {
  const initial = readInflight(dataDir, conversationId)
  if (initial === undefined) {
    return
  }
  const pollMs = Math.max(5, opts.pollIntervalMs ?? 50)
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive
  const maxWaitMs = Math.min(timeoutMs + 2000, 120_000)
  const deadline = Math.min(Date.now() + maxWaitMs, initial.startedAt + maxWaitMs)

  while (true) {
    const current = readInflight(dataDir, conversationId)
    if (current === undefined || current.id !== initial.id) {
      return
    }
    const sl = readStatusLine(dataDir, conversationId)
    if (sl !== undefined && sl.id === initial.id) {
      clearInflight(dataDir, conversationId, initial.id)
      return
    }
    if (current.pid !== undefined && !isAlive(current.pid)) {
      clearInflight(dataDir, conversationId, initial.id)
      return
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return
    }
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(pollMs, remaining)))
  }
}

export const handleHook = async (payload: AgyHookInput, opts: HandleHookOptions = {}): Promise<AgyHookOutput> => {
  const env = opts.env ?? process.env
  if (env[INTERNAL_ENV] === '1') {
    return {}
  }

  const event = payload.hookEventName ?? ''
  const now = opts.now ?? Date.now()
  const cwd = payload.cwd ?? payload.workspacePaths?.[0]
  const conversationId = payload.conversationId ?? 'default'
  const paths = resolvePaths(cwd, env)
  const { settings, lists } = loadConfigAndLists(paths, env)
  const display = resolveEffectiveDisplay(settings.display, payload, env)

  if (event === 'SessionStart') {
    pruneStaleSessions(paths.dataDir, now)
    if (settings.history && lists.history && !existsSync(paths.historyFile) && !readMeta(paths.dataDir).historyAnnounced) {
      markHistoryAnnounced(paths.dataDir)
      if (display === 'user_markdown') {
        return injectUserMarkdown(
          `*prompt-grammar: fixes will be kept in \`${paths.historyFile}\` for \`/grammar stats\` and \`/grammar review\`. Run \`/grammar history off\` to disable.*`,
        )
      }
    }
    return {}
  }

  if (event === 'PostInvocation') {
    // Only `system` and `user_markdown` inject directly on PostInvocation; `async` drains on the next PreInvocation and `statusline` renders via dist/statusline.mjs.
    if (display === 'async' || display === 'statusline') {
      return {}
    }
    const pending = drainPending(paths.dataDir, conversationId)
    if (pending.length === 0) {
      return {}
    }
    if (display === 'user_markdown') {
      const md = pending.map(p => p.markdown ?? p.plain).filter(Boolean).join('\n')
      return md ? injectUserMarkdown(md) : {}
    }
    const text = pending.map(p => p.plain ?? p.markdown).filter(Boolean).join('\n')
    return text ? injectSystemMessage(`Grammar check for your previous prompt:\n${text}`) : {}
  }

  if (event === 'Stop') {
    if (display !== 'statusline' || payload.terminationReason === 'USER_CANCELED') {
      return {}
    }
    await waitForInflightStatusLine(paths.dataDir, conversationId, settings.timeoutMs, {
      pollIntervalMs: opts.pollIntervalMs,
      isPidAlive: opts.isPidAlive,
    })
    return {}
  }

  if (event !== 'PreInvocation') {
    return {}
  }

  // Only fire once per new user turn (invocationNum === 0); ignore tool-call follow-up invocations.
  if (typeof payload.invocationNum === 'number' && payload.invocationNum > 0) {
    return {}
  }

  const rawInput = typedPart(payload.lastUserInput ?? '')
  if (rawInput === '') {
    return {}
  }

  // Intercept /grammar and /prompt-grammar:grammar commands deterministically before the main model runs.
  const cmdMatch = /^\/(?:prompt-grammar:)?grammar(?:\s+([\s\S]*)|$)/i.exec(rawInput)
  if (cmdMatch !== null) {
    const args = (cmdMatch[1] ?? '').trim()
    const output = await runCommand({
      args,
      conversationId,
      paths,
      now,
      completer: opts.completer,
      env,
      effectiveDisplay: display,
    })
    return display === 'user_markdown'
      ? injectUserMarkdown(output, true)
      : injectSystemMessage(verbatimCommandNote(rawInput, output))
  }

  // Async background modes (`display: "async"`, `display: "system"`, or `display: "statusline"`):
  // 1) Drain any already-finished checks from earlier prompts (except `statusline`, which reads its own per-session file).
  // 2) Spawn a detached worker for the current prompt (0 ms blocking).
  if (display === 'async' || display === 'system' || display === 'statusline') {
    const queued = display === 'statusline' ? [] : drainPending(paths.dataDir, conversationId)
    const session = loadSession(paths.dataDir, conversationId, now)
    const canCheck = isProviderReady(settings) && checkableText(rawInput, settings, lists, session.fails) !== undefined
    const pluginRoot = env.PLUGIN_ROOT ?? process.cwd()
    const workerScript = join(pluginRoot, 'dist', 'check-worker.mjs')
    const hasWorker = existsSync(workerScript)

    if (canCheck && hasWorker) {
      const jobId = String(now)
      const startedAt = Date.now()
      if (display === 'statusline') {
        saveInflight(paths.dataDir, conversationId, { id: jobId, startedAt })
      }
      const spawner = opts.spawnWorker ?? defaultSpawnWorker
      const pid = spawner(workerScript, JSON.stringify({ id: jobId, rawInput, conversationId, cwd, now, display }))
      if (display === 'statusline' && typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
        const current = readInflight(paths.dataDir, conversationId)
        if (current?.id === jobId) {
          saveInflight(paths.dataDir, conversationId, { id: jobId, startedAt: current.startedAt, pid })
        }
      }
    }

    if (display === 'statusline') {
      if (!canCheck || hasWorker) {
        return {}
      }
      // Fallback to sync if worker bundle is absent (e.g., dev runs).
    } else if (!canCheck || hasWorker) {
      if (queued.length === 0) {
        return {}
      }
      const md = queued.map(p => p.markdown ?? p.plain).filter(Boolean).join('\n')
      const plain = queued.map(p => p.plain ?? p.markdown).filter(Boolean).join('\n')
      return display === 'async'
        ? md
          ? injectSystemMessage(replyNote(md))
          : {}
        : plain
          ? injectSystemMessage(`Grammar check for your previous prompt:\n${plain}`)
          : {}
    }
  }

  const outcome = await runPromptCheck({
    rawInput,
    conversationId,
    settings,
    lists,
    paths,
    now,
    completer: opts.completer,
  })
  if (outcome.skipped || display === 'statusline') {
    return {}
  }

  if (outcome.check.status === 'error') {
    // Only surface an error when checks just paused after MAX_FAILS; transient failures stay silent.
    if (!outcome.check.paused) {
      return {}
    }
    const msg = outcome.markdown ?? outcome.plain ?? ''
    if (display === 'user_markdown') {
      return injectUserMarkdown(msg)
    }
    return injectSystemMessage(replyNote(msg))
  }

  const rendered = outcome.markdown ?? outcome.plain
  if (!rendered) {
    return {}
  }
  if (display === 'user_markdown') {
    return injectUserMarkdown(rendered)
  }
  return injectSystemMessage(replyNote(rendered))
}
