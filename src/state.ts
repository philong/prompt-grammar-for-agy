// Persistent storage for history, per-session state, one-time notices, and async pending results.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { ENGLISH } from './config'
import { EMPTY_HISTORY, historyText, parseHistory, record } from './history'
import type { History } from './history'
import type { GrammarFix, GrammarTurn } from './types'

export const MAX_FAILS = 3
export const MAX_RECENT_FIXES = 20
const STALE_SESSION_MS = 7 * 86_400_000

export type SessionState = {
  fails: number
  lastError?: string
  streak: number
  recentFixes: (GrammarFix & { language?: string })[]
  thread: GrammarTurn[]
  updatedAt: number
}

export const emptySession = (now = Date.now()): SessionState => ({
  fails: 0,
  streak: 0,
  recentFixes: [],
  thread: [],
  updatedAt: now,
})

const atomicWrite = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9._-]/g, '_') || 'default'

export const sessionPath = (dataDir: string, conversationId: string) => join(dataDir, 'sessions', `${safeId(conversationId)}.json`)
export const pendingPath = (dataDir: string, conversationId: string) => join(dataDir, 'pending', `${safeId(conversationId)}.json`)
export const statusLinePath = (dataDir: string, conversationId: string) => join(dataDir, 'statusline', `${safeId(conversationId)}.json`)
export const metaPath = (dataDir: string) => join(dataDir, 'meta.json')

export const loadSession = (dataDir: string, conversationId: string, now = Date.now()): SessionState => {
  const path = sessionPath(dataDir, conversationId)
  if (!existsSync(path)) {
    return emptySession(now)
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionState>
    return {
      fails: typeof raw.fails === 'number' && Number.isFinite(raw.fails) ? raw.fails : 0,
      ...(typeof raw.lastError === 'string' && raw.lastError !== '' ? { lastError: raw.lastError } : {}),
      streak: typeof raw.streak === 'number' && Number.isFinite(raw.streak) ? raw.streak : 0,
      recentFixes: Array.isArray(raw.recentFixes) ? raw.recentFixes.slice(0, MAX_RECENT_FIXES) : [],
      thread: Array.isArray(raw.thread) ? raw.thread : [],
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
    }
  } catch {
    return emptySession(now)
  }
}

export const saveSession = (dataDir: string, conversationId: string, state: SessionState, now = Date.now()) => {
  atomicWrite(sessionPath(dataDir, conversationId), JSON.stringify({ ...state, updatedAt: now }, null, 2))
}

export const pruneStaleSessions = (dataDir: string, now = Date.now()) => {
  for (const sub of ['sessions', 'pending', 'statusline']) {
    const dir = join(dataDir, sub)
    if (!existsSync(dir)) {
      continue
    }
    try {
      for (const file of readdirSync(dir)) {
        const full = join(dir, file)
        if (now - statSync(full).mtimeMs > STALE_SESSION_MS) {
          unlinkSync(full)
        }
      }
    } catch {
      // Best-effort cleanup.
    }
  }
}

// --- History file helpers ---

export const readHistoryFile = (path: string): History =>
  existsSync(path) ? parseHistory(readFileSync(path, 'utf8')) : EMPTY_HISTORY

export const recordToHistoryFile = (
  path: string,
  fixes: readonly GrammarFix[],
  now: number,
  lang: string = ENGLISH,
): { ok: true } | { ok: false; error: string } => {
  try {
    const current = readHistoryFile(path)
    atomicWrite(path, historyText(record(current, fixes, now, lang)))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export const clearHistoryFile = (path: string) => {
  atomicWrite(path, historyText(EMPTY_HISTORY))
}

// --- One-time meta store ---

export const readMeta = (dataDir: string): { historyAnnounced?: boolean } => {
  const path = metaPath(dataDir)
  if (!existsSync(path)) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { historyAnnounced?: boolean }
  } catch {
    return {}
  }
}

export const markHistoryAnnounced = (dataDir: string) => {
  const meta = readMeta(dataDir)
  atomicWrite(metaPath(dataDir), JSON.stringify({ ...meta, historyAnnounced: true }, null, 2))
}

// --- Async pending queue (used by display: "async" and display: "system") ---

const MAX_PENDING = 10

export type PendingResult = {
  id: string
  markdown?: string
  plain?: string
  createdAt: number
}

const readPendingList = (path: string): PendingResult[] => {
  if (!existsSync(path)) {
    return []
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PendingResult | PendingResult[]
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

export const appendPending = (dataDir: string, conversationId: string, result: PendingResult) => {
  const path = pendingPath(dataDir, conversationId)
  const queue = [...readPendingList(path), result].slice(-MAX_PENDING)
  atomicWrite(path, JSON.stringify(queue))
}

export const drainPending = (dataDir: string, conversationId: string): PendingResult[] => {
  const path = pendingPath(dataDir, conversationId)
  if (!existsSync(path)) {
    return []
  }
  const list = readPendingList(path)
  try {
    unlinkSync(path)
  } catch {
    // Ignore cleanup failure.
  }
  return list
}

// --- Per-conversation status line cache (used by display: "statusline") ---

export type StatusLineEntry = {
  id: string
  ansi: string
  plain: string
  updatedAt: number
}

export const saveStatusLine = (dataDir: string, conversationId: string, entry: StatusLineEntry) => {
  atomicWrite(statusLinePath(dataDir, conversationId), JSON.stringify(entry))
}

export const readStatusLine = (dataDir: string, conversationId: string): StatusLineEntry | undefined => {
  const path = statusLinePath(dataDir, conversationId)
  if (!existsSync(path)) {
    return undefined
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StatusLineEntry> | null
    if (
      raw === null ||
      typeof raw !== 'object' ||
      typeof raw.ansi !== 'string' ||
      typeof raw.plain !== 'string'
    ) {
      return undefined
    }
    return {
      id: typeof raw.id === 'string' ? raw.id : '',
      ansi: raw.ansi,
      plain: raw.plain,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    }
  } catch {
    return undefined
  }
}

export const clearStatusLine = (dataDir: string, conversationId: string) => {
  const path = statusLinePath(dataDir, conversationId)
  if (!existsSync(path)) {
    return
  }
  try {
    unlinkSync(path)
  } catch {
    // Ignore cleanup failure.
  }
}
