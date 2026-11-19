// OpenAI-compatible chat completions client (llama.cpp, LM Studio, Ollama, vLLM, OpenRouter, OpenAI).
// Ported from claude-grammar v1.7.0 using standard fetch + AbortSignal.timeout.

export type EndpointRequest = { system: string; prompt: string; maxTokens: number; timeoutMs: number }
export type EndpointAnswer =
  | { isAnswered: true; text: string }
  | { isAnswered: false; reason: string; gated?: boolean }

export const chatUrl = (endpoint: string) => {
  const base = endpoint.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(base)) {
    return base
  }
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

export const hostOf = (endpoint: string) => {
  try {
    const u = new URL(endpoint)
    return `${u.protocol}//${u.host}`
  } catch {
    return endpoint
  }
}

export type Quirks = { thinking: boolean; temperature: boolean; maxTokens: boolean }
export const NO_QUIRKS: Quirks = { thinking: false, temperature: false, maxTokens: false }

export const chatBody = (model: string, r: EndpointRequest, q: Quirks = NO_QUIRKS) =>
  JSON.stringify({
    ...(model === '' ? {} : { model }),
    ...(q.maxTokens ? { max_completion_tokens: r.maxTokens } : { max_tokens: r.maxTokens }),
    ...(q.temperature ? {} : { temperature: 0 }),
    ...(q.thinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
    stream: false,
    messages: [
      { role: 'system', content: r.system },
      { role: 'user', content: r.prompt },
    ],
  })

export const quirkOf = (q: Quirks, error: string): Quirks | undefined => {
  const e = error.toLowerCase()
  if (!q.thinking && e.includes('chat_template_kwargs')) {
    return { ...q, thinking: true }
  }
  if (!q.maxTokens && e.includes('max_tokens')) {
    return { ...q, maxTokens: true }
  }
  if (!q.temperature && e.includes('temperature')) {
    return { ...q, temperature: true }
  }
  return undefined
}

type Parsed = EndpointAnswer & { status: number; error?: string }

export const chatAnswer = (status: number, text: string): Parsed => {
  let j: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; error?: unknown }
  try {
    j = JSON.parse(text) as typeof j
  } catch {
    return { status, isAnswered: false, reason: `endpoint: HTTP ${status}, not JSON: ${text.slice(0, 120)}` }
  }
  const err = j.error as { message?: unknown } | string | undefined
  if (status < 200 || status >= 300 || err !== undefined) {
    const why = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : text.slice(0, 160)
    return { status, isAnswered: false, reason: `endpoint: HTTP ${status}: ${why}`, error: why }
  }
  const choice = j.choices?.[0]
  const content = choice?.message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    const cut = choice?.finish_reason === 'length' ? ' (cut off at max tokens)' : ''
    return { status, isAnswered: false, reason: `endpoint: empty answer${cut}` }
  }
  return { status, isAnswered: true, text: content }
}

const quirks = new Map<string, Quirks>()

export async function endpointComplete(
  endpoint: string,
  model: string,
  key: string,
  r: EndpointRequest,
  fetcher: typeof fetch = fetch,
): Promise<EndpointAnswer> {
  const url = chatUrl(endpoint)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(key === '' ? {} : { authorization: `Bearer ${key}` }),
  }
  const hide = (s: string) => (key === '' ? s : s.split(key).join('***'))
  const deadline = Date.now() + r.timeoutMs

  const once = async (q: Quirks): Promise<Parsed> => {
    const remaining = Math.max(500, deadline - Date.now())
    try {
      const res = await fetcher(url, {
        method: 'POST',
        headers,
        body: chatBody(model, r, q),
        signal: AbortSignal.timeout(remaining),
      })
      return chatAnswer(res.status, await res.text())
    } catch (err) {
      const msg = err instanceof Error ? (err.name === 'TimeoutError' ? `no answer in ${Math.round(r.timeoutMs / 1000)} s` : err.message) : String(err)
      return { status: 0, isAnswered: false, reason: `endpoint ${hostOf(endpoint)}: ${msg}` }
    }
  }

  let q = quirks.get(url) ?? NO_QUIRKS
  for (let attempt = 0; attempt < 4; attempt++) {
    const a = await once(q)
    const next = !a.isAnswered && a.status === 400 && a.error !== undefined ? quirkOf(q, a.error) : undefined
    if (next === undefined) {
      return a.isAnswered ? { isAnswered: true, text: a.text } : { isAnswered: false, reason: hide(a.reason) }
    }
    q = next
    quirks.set(url, q)
  }
  return { isAnswered: false, reason: 'endpoint: refused every form of the request' }
}
