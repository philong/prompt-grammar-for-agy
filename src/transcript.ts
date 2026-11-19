// Pure Antigravity transcript parsing and batching helpers for scripts/import-history.ts.
import { typedPart } from './check'
import type { Settings } from './config'

export const ENDPOINT_IMPORT_PARALLEL = 3

export type ImportPolicy =
  | { ok: true; parallel: number; delayMs: number }
  | { ok: false; error: string }

/** Resolve concurrency, interval, and endpoint policy for transcript backfill. */
export const resolveImportPolicy = (
  settings: Pick<Settings, 'endpoint'>,
  opts: { dryRun: boolean; delayMs?: number },
): ImportPolicy => {
  if (!opts.dryRun && settings.endpoint === '') {
    return {
      ok: false,
      error:
        'No endpoint configured. Set an OpenAI-compatible endpoint first (/grammar config endpoint <url>, e.g. Ollama, llama.cpp, Google AI Studio, or OpenRouter).',
    }
  }
  return {
    ok: true,
    parallel: ENDPOINT_IMPORT_PARALLEL,
    delayMs: Math.max(0, opts.delayMs ?? 0),
  }
}

export const BATCH_PROMPTS = 20
export const BATCH_CHARS = 8000

export type TranscriptPrompt = { id: number; text: string; at: number; key: string }

const INTERNAL_MARKERS = [
  'Follow the instructions below strictly. Do not call any tools',
  '<INSTRUCTIONS>\nYou proofread ',
  'Answer with JSON only, no prose and no code fence:',
]

/** Extract one user-typed prompt from an Antigravity transcript.jsonl line, or undefined for everything else. */
export const typedAgyText = (line: string, conversationId = ''): Omit<TranscriptPrompt, 'id'> | undefined => {
  if (!line.includes('"USER_INPUT"') || !line.includes('"USER_EXPLICIT"')) {
    return undefined
  }
  let e: Record<string, unknown>
  try {
    e = JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (e.type !== 'USER_INPUT' || e.source !== 'USER_EXPLICIT' || typeof e.content !== 'string' || typeof e.created_at !== 'string') {
    return undefined
  }
  const at = Date.parse(e.created_at)
  if (!Number.isFinite(at)) {
    return undefined
  }
  const text = typedPart(e.content)
  if (text === '' || INTERNAL_MARKERS.some(m => text.includes(m))) {
    return undefined
  }
  const stepIndex = typeof e.step_index === 'number' ? e.step_index : 0
  return { text, at, key: `${conversationId}:${stepIndex}:${at}` }
}

/** Group prompts into model batches capped by prompt count and character budget. */
export const batches = <P extends { text: string }>(prompts: readonly P[]) => {
  const out: P[][] = []
  let cur: P[] = []
  let chars = 0
  for (const p of prompts) {
    if (cur.length > 0 && (cur.length >= BATCH_PROMPTS || chars + p.text.length > BATCH_CHARS)) {
      out.push(cur)
      cur = []
      chars = 0
    }
    cur.push(p)
    chars += p.text.length
  }
  return cur.length > 0 ? [...out, cur] : out
}
