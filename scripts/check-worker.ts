#!/usr/bin/env node
// Detached background worker for `async`, `system`, and `statusline`/`auto` modes (0 ms prompt blocking).
import { loadConfigAndLists, resolvePaths } from '../src/config'
import { runPromptCheck } from '../src/runner'
import { appendPending, clearInflight } from '../src/state'

const main = async () => {
  const rawJob = process.env.PROMPT_GRAMMAR_JOB
  if (!rawJob) {
    return
  }
  const job = JSON.parse(rawJob) as { id?: string; rawInput: string; conversationId: string; cwd?: string; now?: number; display?: string }
  const paths = resolvePaths(job.cwd)
  const { settings, lists } = loadConfigAndLists(paths)
  const effectiveDisplay = job.display ?? settings.display
  const jobId = job.id ?? (typeof job.now === 'number' ? String(job.now) : undefined)
  try {
    const outcome = await runPromptCheck({
      rawInput: job.rawInput,
      conversationId: job.conversationId,
      settings,
      lists,
      paths,
      now: job.now ?? Date.now(),
    })
    if (outcome.skipped || effectiveDisplay === 'statusline') {
      return
    }
    if (outcome.check.status === 'error' && !outcome.check.paused) {
      return
    }
    if (outcome.markdown || outcome.plain) {
      appendPending(paths.dataDir, job.conversationId, {
        id: String(outcome.check.id),
        markdown: outcome.markdown,
        plain: outcome.plain,
        createdAt: Date.now(),
      })
    }
  } finally {
    if (jobId !== undefined) {
      clearInflight(paths.dataDir, job.conversationId, jobId)
    }
  }
}

await main().catch(() => undefined)
