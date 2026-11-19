// Model completion router using the user's configured OpenAI-compatible HTTP endpoint.
import type { Settings } from './config'
import { endpointComplete, hostOf } from './endpoint'
import type { EndpointAnswer } from './endpoint'

export type CompletionRequest = {
  model: string
  system: string
  prompt: string
  maxTokens: number
  timeoutMs: number
}

export type Completer = (req: CompletionRequest) => Promise<EndpointAnswer>

export const INTERNAL_ENV = 'PROMPT_GRAMMAR_INTERNAL'

export const ENDPOINT_REQUIRED_MESSAGE =
  'no endpoint configured; set an OpenAI-compatible endpoint with /grammar config endpoint <url> (e.g. http://localhost:11434 for Ollama or https://generativelanguage.googleapis.com/v1beta/openai for Google AI Studio)'

/** True when an OpenAI-compatible endpoint is configured. */
export const isProviderReady = (s: Settings): boolean => s.endpoint !== ''

/** The model name displayed in help, stats, and footers. */
export const modelName = (s: Settings) => s.endpointModel || 'the default model'

/** Human-readable checker description for /grammar help and /grammar on. */
export const checkerOf = (s: Settings) =>
  s.endpoint !== '' ? `${modelName(s)} at ${hostOf(s.endpoint)}` : 'none (set /grammar config endpoint <url>)'

/** Route a prompt check call to the configured OpenAI-compatible endpoint. */
export const completeCheck = async (
  s: Settings,
  system: string,
  prompt: string,
  timeoutMs?: number,
  completer?: Completer,
): Promise<EndpointAnswer> => {
  if (s.endpoint === '') {
    return { isAnswered: false, gated: true, reason: ENDPOINT_REQUIRED_MESSAGE }
  }
  const req: CompletionRequest = {
    model: s.endpointModel,
    system,
    prompt,
    maxTokens: 2048,
    timeoutMs: timeoutMs ?? Math.max(s.timeoutMs, 30000),
  }
  if (completer !== undefined) {
    return completer(req)
  }
  return endpointComplete(s.endpoint, s.endpointModel, s.endpointKey, req)
}

/** Route /grammar review or /grammar ask to the configured OpenAI-compatible endpoint. */
export const completeCoaching = async (
  s: Settings,
  system: string,
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
  completer?: Completer,
): Promise<{ text: string; model: string } | { refused: string }> => {
  if (s.endpoint === '') {
    return { refused: ENDPOINT_REQUIRED_MESSAGE }
  }
  const req: CompletionRequest = { model: s.endpointModel, system, prompt, maxTokens, timeoutMs }
  const r = completer !== undefined ? await completer(req) : await endpointComplete(s.endpoint, s.endpointModel, s.endpointKey, req)
  return r.isAnswered ? { text: r.text.trim(), model: modelName(s) } : { refused: r.reason }
}
