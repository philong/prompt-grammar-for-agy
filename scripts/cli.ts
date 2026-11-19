#!/usr/bin/env node
// Standalone CLI for running /grammar commands directly in a terminal with zero model tokens.
// Usage: node dist/cli.mjs stats 7d | on | off | ignore add kubectl | config endpoint http://localhost:11434
import { runCommand } from '../src/commands'
import { resolvePaths } from '../src/config'

const main = async () => {
  const args = process.argv.slice(2).join(' ')
  const paths = resolvePaths(process.cwd())
  const output = await runCommand({
    args: args === '' ? 'help' : args,
    conversationId: process.env.PROMPT_GRAMMAR_SESSION ?? 'cli',
    paths,
  })
  process.stdout.write(`${output}\n`)
}

await main()
