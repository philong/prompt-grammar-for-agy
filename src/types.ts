// Shared domain types for prompt-grammar (ported from claude-grammar v1.7.0).

/** One grammar fix: `why` is '' when `show_why` is off; `kind` is asked for while history is on. */
export type GrammarFix = { from: string; to: string; why: string; kind?: string }

/** Parsed model reply: fixes, optional native-speaker rewrite, and language named in English. */
export type GrammarReply = { fixes: GrammarFix[]; natural: string | null; language: string }

/** A single prompt check result recorded in session state. */
export type GrammarCheck = {
  id: number
  text: string
  status: 'done' | 'error'
  fixes: GrammarFix[]
  natural?: string | null
  error?: string
  paused?: boolean
  streak?: number
  language?: string
}

/** One exchange remembered for /grammar ask follow-ups. */
export type GrammarTurn = { q: string; a: string }

/** Hook stdin payload fields provided by Antigravity. */
export type AgyHookInput = {
  hookEventName?: string
  conversationId?: string
  workspacePaths?: string[]
  transcriptPath?: string
  artifactDirectoryPath?: string
  modelName?: string
  lastUserInput?: string
  cwd?: string
  invocationNum?: number
  initialNumSteps?: number
}

/** Hook stdout payload returned to Antigravity for SessionStart / PreInvocation / PostInvocation. */
export type AgyHookOutput = {
  injectSteps?: Array<
    | { systemMessage: { systemMessage: string; metadata?: Record<string, string> } }
    | { userMessage: string }
    | { errorMessage: { userMessage: string } }
  >
  terminationBehavior?: '' | 'terminate' | 'force_continue'
}
