import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCommand } from '../src/commands'
import { resolvePaths } from '../src/config'
import { handleHook } from '../src/hook-handler'
import { ENDPOINT_REQUIRED_MESSAGE, INTERNAL_ENV } from '../src/providers'
import type { Completer } from '../src/providers'
import { appendPending, loadSession, readHistoryFile } from '../src/state'
import { buildStatusLineCommand, renderStatusLine } from '../src/statusline'

let tmpDir = ''
let env: Record<string, string | undefined> = {}
const NOW = Date.UTC(2026, 9, 30, 12)

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'prompt-grammar-test-'))
  const configDir = join(tmpDir, 'config')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'grammar.json'), JSON.stringify({ endpoint: 'http://mock.local', endpoint_model: 'mock-model' }))
  env = {
    HOME: tmpDir,
    PROMPT_GRAMMAR_CONFIG_DIR: configDir,
    PLUGIN_DATA: join(tmpDir, 'data'),
    PLUGIN_ROOT: join(tmpDir, 'plugin'),
    AGY_CLI_SETTINGS: join(tmpDir, 'agy-settings.json'),
  }
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

const mockCompleter = (reply: string | ((model: string, prompt: string) => { isAnswered: true; text: string } | { isAnswered: false; reason: string })): { fn: Completer; models: string[]; prompts: string[] } => {
  const models: string[] = []
  const prompts: string[] = []
  const fn: Completer = async req => {
    models.push(req.model)
    prompts.push(req.prompt)
    return typeof reply === 'string' ? { isAnswered: true, text: reply } : reply(req.model, req.prompt)
  }
  return { fn, models, prompts }
}

describe('hook contract', () => {
  test('PROMPT_GRAMMAR_INTERNAL=1 short-circuits immediately', async () => {
    const m = mockCompleter('{"english":true,"fixes":[]}')
    const out = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c1', lastUserInput: 'it should appea here' },
      { env: { ...env, [INTERNAL_ENV]: '1' }, completer: m.fn, now: NOW },
    )
    expect(out).toEqual({})
    expect(m.prompts.length).toBe(0)
  })

  test('ignores tool-loop invocations where invocationNum > 0', async () => {
    const m = mockCompleter('{"english":true,"fixes":[{"from":"appea","to":"appear","why":"typo","kind":"spelling"}]}')
    const out = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 1, conversationId: 'c1', lastUserInput: 'it should appea here' },
      { env, completer: m.fn, now: NOW },
    )
    expect(out).toEqual({})
    expect(m.prompts.length).toBe(0)
  })

  test('reply mode injects fixes, records history, and tracks clean streak', async () => {
    const typo = mockCompleter(
      JSON.stringify({
        english: true,
        fixes: [{ from: 'appea', to: 'appear', why: 'typo', kind: 'spelling' }],
        natural: 'it should show up here',
      }),
    )
    const out1 = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c1', lastUserInput: 'it should appea here' },
      { env, completer: typo.fn, now: NOW },
    )
    const msg1 = (out1.injectSteps?.[0] as { systemMessage?: { systemMessage: string } })?.systemMessage?.systemMessage ?? ''
    expect(msg1).toContain('~~appea~~ **appear** *(typo)*')
    expect(msg1).toContain('↳ *it should show up here*')

    const paths = resolvePaths(undefined, env)
    const hist = readHistoryFile(paths.historyFile)
    expect(hist.fixes.length).toBe(1)
    expect(hist.fixes[0]?.from).toBe('appea')

    // 3 clean prompts in a row trigger the streak note on prompt #3.
    const clean = mockCompleter('{"english":true,"fixes":[],"natural":null}')
    const c1 = await handleHook({ hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c1', lastUserInput: 'please deploy to staging' }, { env, completer: clean.fn, now: NOW + 10_000 })
    const c2 = await handleHook({ hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c1', lastUserInput: 'please check the logs' }, { env, completer: clean.fn, now: NOW + 20_000 })
    const c3 = await handleHook({ hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c1', lastUserInput: 'please run the tests' }, { env, completer: clean.fn, now: NOW + 30_000 })
    expect(c1).toEqual({})
    expect(c2).toEqual({})
    const msg3 = (c3.injectSteps?.[0] as { systemMessage?: { systemMessage: string } })?.systemMessage?.systemMessage ?? ''
    expect(msg3).toContain('3 in a row')
  })

  test('pauses after 3 consecutive failures and resumes on /grammar on', async () => {
    const failing = mockCompleter(() => ({ isAnswered: false, reason: 'timeout' }))
    const f1 = await handleHook({ hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c2', lastUserInput: 'please check this' }, { env, completer: failing.fn, now: NOW })
    const f2 = await handleHook({ hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c2', lastUserInput: 'please check that' }, { env, completer: failing.fn, now: NOW + 10_000 })
    const f3 = await handleHook({ hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c2', lastUserInput: 'please check more' }, { env, completer: failing.fn, now: NOW + 20_000 })
    const f4 = await handleHook({ hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c2', lastUserInput: 'please check again' }, { env, completer: failing.fn, now: NOW + 30_000 })
    expect(f1).toEqual({})
    expect(f2).toEqual({})
    expect((f3.injectSteps?.[0] as { systemMessage?: { systemMessage: string } })?.systemMessage?.systemMessage).toContain('paused after 3 failures')
    expect(f4).toEqual({})
    expect(failing.prompts.length).toBe(3)

    // /grammar on resets failure pause.
    const onOut = await handleHook({ hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c2', lastUserInput: '/grammar on' }, { env, completer: failing.fn, now: NOW + 40_000 })
    expect((onOut.injectSteps?.[0] as { systemMessage?: { systemMessage: string } })?.systemMessage?.systemMessage).toContain('English check on')
  })

  test('system and async modes queue pending checks without overwriting and drain in PreInvocation/PostInvocation', async () => {
    const paths = resolvePaths(undefined, env)
    await runCommand({ args: 'config display system', conversationId: 'c3', paths, now: NOW })
    const workerPath = join(env.PLUGIN_ROOT!, 'dist', 'check-worker.mjs')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(env.PLUGIN_ROOT!, 'dist'), { recursive: true })
    writeFileSync(workerPath, '// stub')

    const spawned: string[] = []
    const pre1 = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c3', lastUserInput: 'it should appea here' },
      { env, now: NOW, spawnWorker: (_script, job) => spawned.push(job) },
    )
    expect(pre1).toEqual({})
    expect(spawned[0]).toContain('it should appea here')

    // Multiple background results queue instead of overwriting.
    appendPending(paths.dataDir, 'c3', { id: '1', plain: '✎ appea → appear (typo)', markdown: '✎ ~~appea~~ **appear** *(typo)*', createdAt: NOW })
    appendPending(paths.dataDir, 'c3', { id: '2', plain: '✎ teste → test (typo)', markdown: '✎ ~~teste~~ **test** *(typo)*', createdAt: NOW + 1000 })

    // Next PreInvocation drains both while spawning the new worker.
    const pre2 = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c3', lastUserInput: 'another prompt here' },
      { env, now: NOW + 2000, spawnWorker: (_script, job) => spawned.push(job) },
    )
    const pre2Msg = (pre2.injectSteps?.[0] as { systemMessage?: { systemMessage: string } })?.systemMessage?.systemMessage ?? ''
    expect(pre2Msg).toContain('appea → appear')
    expect(pre2Msg).toContain('teste → test')
    expect(spawned.length).toBe(2)

    // PostInvocation also drains if a result lands mid-turn.
    appendPending(paths.dataDir, 'c3', { id: '3', plain: '✎ helo → hello (typo)', createdAt: NOW + 3000 })
    const post = await handleHook({ hookEventName: 'PostInvocation', invocationNum: 0, conversationId: 'c3' }, { env, now: NOW + 3000 })
    const postMsg = (post.injectSteps?.[0] as { systemMessage?: { systemMessage: string } })?.systemMessage?.systemMessage ?? ''
    expect(postMsg).toContain('helo → hello')
    expect(await handleHook({ hookEventName: 'PostInvocation', invocationNum: 1, conversationId: 'c3' }, { env, now: NOW + 3000 })).toEqual({})

    // `async` mode skips PostInvocation and drains visibly via replyNote on the next PreInvocation.
    await runCommand({ args: 'config display async', conversationId: 'c3', paths, now: NOW + 4000 })
    appendPending(paths.dataDir, 'c3', { id: '4', markdown: '✎ ~~helo~~ **hello** *(typo)*', createdAt: NOW + 4000 })
    expect(await handleHook({ hookEventName: 'PostInvocation', invocationNum: 0, conversationId: 'c3' }, { env, now: NOW + 4000 })).toEqual({})
    const asyncPre = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c3', lastUserInput: 'next message here' },
      { env, now: NOW + 5000, spawnWorker: (_script, job) => spawned.push(job) },
    )
    const asyncMsg = (asyncPre.injectSteps?.[0] as { systemMessage?: { systemMessage: string } })?.systemMessage?.systemMessage ?? ''
    expect(asyncMsg).toContain('End your reply with a blank line')
    expect(asyncMsg).toContain('~~helo~~ **hello**')
  })

  test('user_markdown mode emits hidden metadata and terminates /grammar and /prompt-grammar:grammar commands', async () => {
    const paths = resolvePaths(undefined, env)
    await runCommand({ args: 'config display user_markdown', conversationId: 'c4', paths, now: NOW })
    for (const cmd of ['/grammar help', '/prompt-grammar:grammar help']) {
      const out = await handleHook(
        { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'c4', lastUserInput: cmd },
        { env, now: NOW },
      )
      expect(out.terminationBehavior).toBe('terminate')
      const step = out.injectSteps?.[0] as { systemMessage?: { systemMessage: string; metadata?: Record<string, string> } }
      expect(step.systemMessage?.systemMessage).toBe('')
      expect(step.systemMessage?.metadata?.user_markdown).toContain('/grammar stats')
    }
  })
})

describe('/grammar commands', () => {
  test('config, ignore, stats, review, ask memory, and history commands work end-to-end', async () => {
    const paths = resolvePaths(undefined, env)

    const cfg = await runCommand({ args: 'config endpoint_model qwen2.5:7b', conversationId: 'cmd1', paths, now: NOW, env })
    expect(cfg).toContain('Updated endpoint_model = qwen2.5:7b')

    const help = await runCommand({ args: 'help', conversationId: 'cmd1', paths, now: NOW, env })
    expect(help).toContain('qwen2.5:7b')

    const add = await runCommand({ args: 'ignore add kubectl, pull request', conversationId: 'cmd1', paths, now: NOW, env })
    expect(add).toContain('"kubectl"')
    expect(await runCommand({ args: 'ignore', conversationId: 'cmd1', paths, now: NOW, env })).toContain('kubectl, pull request')

    // Seed 20 fixes via hook checks to exercise stats, review, and ask follow-ups.
    const fixReply = JSON.stringify({
      english: true,
      fixes: [{ from: 'depend from', to: 'depend on', why: 'preposition', kind: 'preposition' }],
      natural: null,
    })
    const m = mockCompleter(fixReply)
    for (let i = 0; i < 20; i++) {
      await handleHook(
        { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'cmd1', lastUserInput: `it will depend from this case ${i}` },
        { env, completer: m.fn, now: NOW - (20 - i) * 60_000 },
      )
    }

    const stats = await runCommand({ args: 'stats', conversationId: 'cmd1', paths, now: NOW, env })
    expect(stats).toContain('20 fixes kept')
    expect(stats).toContain('depend from → depend on')

    const coach = mockCompleter('1. Use "depend on" instead of "depend from".\n  depend from → depend on')
    const rev = await runCommand({ args: 'review', conversationId: 'cmd1', paths, now: NOW, completer: coach.fn, env })
    expect(rev).toContain('Grammar review')
    expect(rev).toContain('~~depend from~~ **depend on**')

    const ask1 = await runCommand({ args: 'ask explain why', conversationId: 'cmd1', paths, now: NOW + 10_000, completer: coach.fn, env })
    expect(ask1).toContain('remembered 1 earlier')
    expect(coach.prompts[1]).toContain('Earlier in this conversation')

    const list = await runCommand({ args: 'ask list', conversationId: 'cmd1', paths, now: NOW + 10_000, env })
    expect(list).toContain('remember 2 exchanges')

    const cleared = await runCommand({ args: 'ask clear', conversationId: 'cmd1', paths, now: NOW + 10_000, env })
    expect(cleared).toContain('Forgot 2 exchanges')

    const hClear = await runCommand({ args: 'history clear', conversationId: 'cmd1', paths, now: NOW + 10_000, env })
    expect(hClear).toContain('holds no fixes now')
  })
})

describe('statusline display mode', () => {
  test('PreInvocation/PostInvocation stay silent, sync fallback updates statusline, and renderStatusLine respects flags', async () => {
    const paths = resolvePaths(undefined, env)
    const cfgOut = await runCommand({ args: 'config display statusline', conversationId: 'sl1', paths, now: NOW, env })
    expect(cfgOut).toContain('Updated display = statusline')
    expect(cfgOut).toContain('/grammar statusline install')

    // Without dist/check-worker.mjs, PreInvocation runs sync fallback and still returns {} (0 injectSteps).
    const typo = mockCompleter(
      JSON.stringify({
        english: true,
        fixes: [{ from: 'appea', to: 'appear', why: 'typo', kind: 'spelling' }],
        natural: 'it should show up here',
      }),
    )
    const syncPre = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'sl1', lastUserInput: 'it should appea here' },
      { env, completer: typo.fn, now: NOW },
    )
    expect(syncPre).toEqual({})
    expect(await handleHook({ hookEventName: 'PostInvocation', invocationNum: 0, conversationId: 'sl1' }, { env, now: NOW })).toEqual({})

    const ansi = renderStatusLine({ conversation_id: 'sl1' }, { env })
    expect(ansi).toContain('\x1b[36m✎\x1b[0m')
    expect(ansi).toContain('\x1b[32mappear\x1b[0m \x1b[2m(typo)\x1b[0m')
    expect(ansi).not.toContain('\x1b[31;9mappea\x1b[0m')
    expect(ansi).toContain('\x1b[36m↳\x1b[0m \x1b[2;3mit should show up here\x1b[0m')

    // session_id fallback and NO_COLOR work.
    const plain = renderStatusLine({ session_id: 'sl1' }, { env: { ...env, NO_COLOR: '1' } })
    expect(plain).toContain('✎ appear (typo)')
    expect(plain).not.toContain('appea →')
    expect(plain).toContain('↳ it should show up here')
    expect(plain).not.toContain('\x1b[')

    expect(renderStatusLine({}, { env })).toBe('')
    expect(renderStatusLine({ conversation_id: 'other' }, { env })).toBe('')

    // Skipped prompt ("ok") leaves previous statusline entry intact.
    const clean = mockCompleter('{"english":true,"fixes":[],"natural":null}')
    await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'sl1', lastUserInput: 'ok' },
      { env, completer: clean.fn, now: NOW + 500 },
    )
    expect(renderStatusLine({ conversation_id: 'sl1' }, { env })).toContain('appear')

    // Clean prompts overwrite stale fixes with "✓ No mistakes", adding "· N in a row" from 3.
    await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'sl1', lastUserInput: 'please deploy to staging' },
      { env, completer: clean.fn, now: NOW + 10_000 },
    )
    expect(renderStatusLine({ conversation_id: 'sl1' }, { env })).toBe('\x1b[32m✓ No mistakes\x1b[0m')

    await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'sl1', lastUserInput: 'please check the logs' },
      { env, completer: clean.fn, now: NOW + 20_000 },
    )
    await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'sl1', lastUserInput: 'please run the tests' },
      { env, completer: clean.fn, now: NOW + 30_000 },
    )
    expect(renderStatusLine({ conversation_id: 'sl1' }, { env })).toBe('\x1b[32m✓ No mistakes\x1b[0m\x1b[2m · 3 in a row\x1b[0m')

    // clean: false clears the status line on clean prompts.
    await runCommand({ args: 'config clean false', conversationId: 'sl1', paths, now: NOW + 35_000, env })
    await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'sl1', lastUserInput: 'please verify the build' },
      { env, completer: clean.fn, now: NOW + 40_000 },
    )
    expect(renderStatusLine({ conversation_id: 'sl1' }, { env })).toBe('')

    // With dist/check-worker.mjs present, PreInvocation spawns worker and returns {}.
    mkdirSync(join(env.PLUGIN_ROOT!, 'dist'), { recursive: true })
    writeFileSync(join(env.PLUGIN_ROOT!, 'dist', 'check-worker.mjs'), '// stub')
    const spawned: string[] = []
    const asyncPre = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'sl1', lastUserInput: 'it should appea here' },
      { env, now: NOW + 50_000, spawnWorker: (_script, job) => spawned.push(job) },
    )
    expect(asyncPre).toEqual({})
    expect(spawned.length).toBe(1)

    // When enabled: false or display !== 'statusline', renderStatusLine returns ''.
    await runCommand({ args: 'off', conversationId: 'sl1', paths, now: NOW + 60_000, env })
    await runCommand({ args: 'on', conversationId: 'sl1', paths, now: NOW + 70_000, env })
    await runCommand({ args: 'config clean true', conversationId: 'sl1', paths, now: NOW + 75_000, env })
    writeFileSync(join(env.PLUGIN_ROOT!, 'dist', 'check-worker.mjs'), '// stub')
    // Populate one entry again via reply mode check or direct fallback, then toggle off/display.
    await runCommand({ args: 'config display reply', conversationId: 'sl1', paths, now: NOW + 80_000, env })
    await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'sl1', lastUserInput: 'it should appea here' },
      { env, completer: typo.fn, now: NOW + 85_000 },
    )
    expect(renderStatusLine({ conversation_id: 'sl1' }, { env })).toBe('')
    await runCommand({ args: 'config display statusline', conversationId: 'sl1', paths, now: NOW + 90_000, env })
    expect(renderStatusLine({ conversation_id: 'sl1' }, { env })).toContain('appear')
    await runCommand({ args: 'off', conversationId: 'sl1', paths, now: NOW + 95_000, env })
    expect(renderStatusLine({ conversation_id: 'sl1' }, { env })).toBe('')
  })

  test('statusline shows strikethrough for removals and correction only for replacements', async () => {
    const paths = resolvePaths(undefined, env)
    await runCommand({ args: 'config display statusline', conversationId: 'sl-mixed', paths, now: NOW, env })
    const mixed = mockCompleter(
      JSON.stringify({
        english: true,
        fixes: [
          { from: 'reads', to: '', why: 'extra word', kind: 'extra word' },
          { from: 'check', to: 'checks', why: 'subject-verb agreement', kind: 'agreement' },
        ],
        natural: null,
      }),
    )
    const out = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'sl-mixed', lastUserInput: 'it reads check here' },
      { env, completer: mixed.fn, now: NOW },
    )
    expect(out).toEqual({})

    const ansi = renderStatusLine({ conversation_id: 'sl-mixed' }, { env })
    expect(ansi).toContain('\x1b[31;9mreads\x1b[0m \x1b[2m(remove)\x1b[0m \x1b[2m(extra word)\x1b[0m')
    expect(ansi).toContain('\x1b[32mchecks\x1b[0m \x1b[2m(subject-verb agreement)\x1b[0m')
    expect(ansi).not.toContain('\x1b[31;9mcheck\x1b[0m')

    const plain = renderStatusLine({ conversation_id: 'sl-mixed' }, { env: { ...env, NO_COLOR: '1' } })
    expect(plain).toContain('reads (remove) (extra word)')
    expect(plain).toContain('checks (subject-verb agreement)')
    expect(plain).not.toContain('check →')
  })

  test('/grammar statusline install, --force guard, and uninstall manage AGY_CLI_SETTINGS safely', async () => {
    const paths = resolvePaths(undefined, env)
    const agySettings = env.AGY_CLI_SETTINGS!
    writeFileSync(agySettings, JSON.stringify({ theme: 'dark', statusLine: { type: '', command: '', enabled: true } }, null, 2))
    chmodSync(agySettings, 0o600)

    const beforeStatus = await runCommand({ args: 'statusline', conversationId: 'sl2', paths, now: NOW, env })
    expect(beforeStatus).toContain('not installed')

    const installed = await runCommand({ args: 'statusline install', conversationId: 'sl2', paths, now: NOW, env })
    expect(installed).toContain('stack_with_default: true')
    expect(installed).toContain('Updated display = auto')

    const rawAfter = JSON.parse(readFileSync(agySettings, 'utf8')) as {
      theme: string
      statusLine: { type: string; command: string; stack_with_default: boolean; padding: number; enabled: boolean }
    }
    expect(rawAfter.theme).toBe('dark')
    expect(rawAfter.statusLine.type).toBe('command')
    expect(rawAfter.statusLine.stack_with_default).toBe(true)
    expect(rawAfter.statusLine.padding).toBe(0)
    expect(rawAfter.statusLine.enabled).toBe(true)
    expect(rawAfter.statusLine.command).toContain('statusline.mjs')
    expect(rawAfter.statusLine.command).toContain(process.platform === 'win32' ? 'if exist ' : '[ ! -f ')
    expect(rawAfter.statusLine.command).toContain(process.platform === 'win32' ? ' node ' : ' ] || exec node ')
    expect(statSync(agySettings).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(paths.globalConfig, 'utf8')).display).toBe('auto')

    // Upgrading an unguarded statusLine command succeeds without --force.
    writeFileSync(
      agySettings,
      JSON.stringify({ statusLine: { type: 'command', command: 'node /old/prompt-grammar/dist/statusline.mjs', enabled: true } }, null, 2),
    )
    const upgraded = await runCommand({ args: 'statusline install', conversationId: 'sl2', paths, now: NOW, env })
    expect(upgraded).toContain('Installed prompt-grammar statusLine')
    const upgradedCmd = JSON.parse(readFileSync(agySettings, 'utf8')).statusLine.command as string
    expect(upgradedCmd).toContain(process.platform === 'win32' ? 'if exist ' : '[ ! -f ')

    const afterStatus = await runCommand({ args: 'statusline', conversationId: 'sl2', paths, now: NOW, env })
    expect(afterStatus).toContain('installed (enabled, stack_with_default: true)')

    // Guard against overwriting an existing custom statusLine without --force.
    writeFileSync(
      agySettings,
      JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'echo custom', enabled: true } }, null, 2),
    )
    const refused = await runCommand({ args: 'statusline install', conversationId: 'sl2', paths, now: NOW, env })
    expect(refused).toContain('already configures another statusLine command: echo custom')
    expect(refused).toContain('--force')
    expect(JSON.parse(readFileSync(agySettings, 'utf8')).statusLine.command).toBe('echo custom')

    const forced = await runCommand({ args: 'statusline install --force', conversationId: 'sl2', paths, now: NOW, env })
    expect(forced).toContain('Installed prompt-grammar statusLine')
    expect(JSON.parse(readFileSync(agySettings, 'utf8')).statusLine.command).toContain('statusline.mjs')

    // Both explicit `display: "statusline"` and `display: "auto"` reset to `reply` on uninstall.
    await runCommand({ args: 'config display statusline', conversationId: 'sl2', paths, now: NOW, env })
    const uninstalled = await runCommand({ args: 'statusline uninstall', conversationId: 'sl2', paths, now: NOW, env })
    expect(uninstalled).toContain('Removed prompt-grammar statusLine')
    expect(uninstalled).toContain('Reset display = reply')
    const afterUninstall = JSON.parse(readFileSync(agySettings, 'utf8')) as {
      theme: string
      statusLine: { type: string; command: string; enabled: boolean }
    }
    expect(afterUninstall.theme).toBe('dark')
    expect(afterUninstall.statusLine).toEqual({ type: '', command: '', enabled: true })
    expect(JSON.parse(readFileSync(paths.globalConfig, 'utf8')).display).toBe('reply')

    await runCommand({ args: 'statusline install', conversationId: 'sl2', paths, now: NOW, env })
    expect(JSON.parse(readFileSync(paths.globalConfig, 'utf8')).display).toBe('auto')
    const uninstalledAuto = await runCommand({ args: 'statusline uninstall', conversationId: 'sl2', paths, now: NOW, env })
    expect(uninstalledAuto).toContain('Removed prompt-grammar statusLine')
    expect(uninstalledAuto).toContain('Reset display = reply')
    expect(JSON.parse(readFileSync(paths.globalConfig, 'utf8')).display).toBe('reply')

    // uninstall must leave third-party statusLine commands untouched.
    writeFileSync(
      agySettings,
      JSON.stringify({ statusLine: { type: 'command', command: 'echo other', enabled: true } }, null, 2),
    )
    const untouched = await runCommand({ args: 'statusline uninstall', conversationId: 'sl2', paths, now: NOW, env })
    expect(untouched).toContain('untouched')
    expect(JSON.parse(readFileSync(agySettings, 'utf8')).statusLine.command).toBe('echo other')
  })

  if (process.platform !== 'win32') {
    test('guarded statusLine command exits 0 when script is missing and runs node with stdin when present', () => {
      const missingPath = join(tmpDir, 'missing', 'statusline.mjs')
      const missingRes = spawnSync('sh', ['-c', buildStatusLineCommand(missingPath, 'linux')], {
        input: '{"conversation_id":"c1"}',
        encoding: 'utf8',
      })
      expect(missingRes.status).toBe(0)
      expect(missingRes.stdout).toBe('')
      expect(missingRes.stderr).toBe('')

      const stubDir = join(tmpDir, 'stub dir')
      mkdirSync(stubDir, { recursive: true })
      const stubPath = join(stubDir, 'statusline.mjs')
      writeFileSync(
        stubPath,
        "import { readFileSync } from 'node:fs'\nprocess.stdout.write(`ok:${readFileSync(0, 'utf8')}`)\n",
      )
      const presentRes = spawnSync('sh', ['-c', buildStatusLineCommand(stubPath, 'linux')], {
        input: 'ping',
        encoding: 'utf8',
      })
      expect(presentRes.status).toBe(0)
      expect(presentRes.stdout).toBe('ok:ping')
      expect(presentRes.stderr).toBe('')
    })
  }

  test('display: "auto" picks statusline in CLI (when installed) and reply in IDE/Desktop without config changes', async () => {
    const paths = resolvePaths(undefined, env)
    const typo = mockCompleter(
      JSON.stringify({
        english: true,
        fixes: [{ from: 'appea', to: 'appear', why: 'typo', kind: 'spelling' }],
        natural: null,
      }),
    )
    const cliTranscript = join(tmpDir, '.gemini', 'antigravity-cli', 'brain', 'c', 'transcript.jsonl')
    const ideTranscript = join(tmpDir, '.gemini', 'antigravity-ide', 'brain', 'c', 'transcript.jsonl')
    const desktopTranscript = join(tmpDir, '.gemini', 'antigravity', 'brain', 'c', 'transcript.jsonl')

    // Default (unset `display`) uses `reply` in CLI.
    const freshCli = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'auto1', transcriptPath: cliTranscript, lastUserInput: 'it should appea here' },
      { env, completer: typo.fn, now: NOW },
    )
    const freshMsg = (freshCli.injectSteps?.[0] as { systemMessage?: { systemMessage: string } })?.systemMessage?.systemMessage ?? ''
    expect(freshMsg).toContain('~~appea~~ **appear**')

    // Explicit `display: "auto"` without statusLine installed also falls back to `reply` in CLI.
    await runCommand({ args: 'config display auto', conversationId: 'auto1', paths, now: NOW, env })
    const autoNoSl = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'auto1b', transcriptPath: cliTranscript, lastUserInput: 'it should appea here' },
      { env, completer: typo.fn, now: NOW + 10_000 },
    )
    const autoNoSlMsg = (autoNoSl.injectSteps?.[0] as { systemMessage?: { systemMessage: string } })?.systemMessage?.systemMessage ?? ''
    expect(autoNoSlMsg).toContain('~~appea~~ **appear**')

    // After `/grammar statusline install` (which sets `display: "auto"`):
    await runCommand({ args: 'statusline install', conversationId: 'auto1', paths, now: NOW + 10_000, env })

    // 1) CLI sync fallback updates statusline cache and returns {} (0 injectSteps).
    const cliSync = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'auto-cli', transcriptPath: cliTranscript, lastUserInput: 'it should appea here' },
      { env, completer: typo.fn, now: NOW + 20_000 },
    )
    expect(cliSync).toEqual({})
    expect(renderStatusLine({ conversation_id: 'auto-cli' }, { env })).toContain('\x1b[32mappear\x1b[0m')

    // 2) CLI with dist/check-worker.mjs present spawns worker with `"display":"statusline"`.
    mkdirSync(join(env.PLUGIN_ROOT!, 'dist'), { recursive: true })
    writeFileSync(join(env.PLUGIN_ROOT!, 'dist', 'check-worker.mjs'), '// stub')
    const spawned: string[] = []
    const cliAsync = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'auto-cli-2', transcriptPath: cliTranscript, lastUserInput: 'it should appea here' },
      { env, now: NOW + 30_000, spawnWorker: (_s, job) => spawned.push(job) },
    )
    expect(cliAsync).toEqual({})
    expect(JSON.parse(spawned[0] ?? '{}').display).toBe('statusline')

    // 3) IDE and Desktop with the exact same config resolve `auto` -> `reply` and inject fixes inline.
    for (const [idx, tPath] of [ideTranscript, desktopTranscript].entries()) {
      const out = await handleHook(
        { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: `auto-gui-${idx}`, transcriptPath: tPath, lastUserInput: 'it should appea here' },
        { env, completer: typo.fn, now: NOW + 40_000 + idx * 10_000 },
      )
      const msg = (out.injectSteps?.[0] as { systemMessage?: { systemMessage: string } })?.systemMessage?.systemMessage ?? ''
      expect(msg).toContain('~~appea~~ **appear**')
    }

    // 4) Explicit `display: "reply"` overrides `auto` even in CLI, and `renderStatusLine` returns ''.
    await runCommand({ args: 'config display reply', conversationId: 'auto1', paths, now: NOW + 55_000, env })
    const cliOverride = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'auto-cli', transcriptPath: cliTranscript, lastUserInput: 'it should appea here' },
      { env, completer: typo.fn, now: NOW + 60_000 },
    )
    expect((cliOverride.injectSteps?.[0] as { systemMessage?: { systemMessage: string } })?.systemMessage?.systemMessage).toContain('~~appea~~ **appear**')
    expect(renderStatusLine({ conversation_id: 'auto-cli' }, { env })).toBe('')

    // 5) Explicit `display: "statusline"` forces `statusline` even on IDE.
    await runCommand({ args: 'config display statusline', conversationId: 'auto1', paths, now: NOW + 65_000, env })
    const ideForced = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'auto-ide-forced', transcriptPath: ideTranscript, lastUserInput: 'it should appea here' },
      { env, now: NOW + 70_000, spawnWorker: (_s, job) => spawned.push(job) },
    )
    expect(ideForced).toEqual({})
    expect(spawned.length).toBe(2)
    expect(JSON.parse(spawned[1] ?? '{}').display).toBe('statusline')
  })
})

describe('endpoint requirement and live HTTP endpoint', () => {
  test('skips hooks and refuses coaching cleanly when endpoint is unset', async () => {
    const emptyEnv: Record<string, string | undefined> = { ...env, PROMPT_GRAMMAR_CONFIG_DIR: join(tmpDir, 'empty-config') }
    const paths = resolvePaths(undefined, emptyEnv)
    const m = mockCompleter('{"english":true,"fixes":[{"from":"appea","to":"appear","why":"typo","kind":"spelling"}],"natural":null}')

    // 1) Sync PreInvocation skips silently with 0 completer calls and 0 failures.
    const syncOut = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'gate1', lastUserInput: 'it should appea here' },
      { env: emptyEnv, completer: m.fn, now: NOW },
    )
    expect(syncOut).toEqual({})
    expect(m.prompts.length).toBe(0)
    expect(loadSession(paths.dataDir, 'gate1', NOW).fails).toBe(0)

    // 2) Async/statusline PreInvocation does not spawn detached workers when endpoint is unset.
    mkdirSync(join(emptyEnv.PLUGIN_ROOT!, 'dist'), { recursive: true })
    writeFileSync(join(emptyEnv.PLUGIN_ROOT!, 'dist', 'check-worker.mjs'), '// stub')
    await runCommand({ args: 'config display system', conversationId: 'gate1', paths, now: NOW, env: emptyEnv })
    const spawned: string[] = []
    const asyncOut = await handleHook(
      { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'gate1', lastUserInput: 'it should appea here' },
      { env: emptyEnv, now: NOW + 10_000, spawnWorker: (_s, job) => spawned.push(job) },
    )
    expect(asyncOut).toEqual({})
    expect(spawned.length).toBe(0)

    // 3) /grammar help and /grammar on explain waiting-for-endpoint state.
    const help = await runCommand({ args: 'help', conversationId: 'gate1', paths, now: NOW, env: emptyEnv })
    expect(help).toContain('waiting for endpoint')
    const onOut = await runCommand({ args: 'on', conversationId: 'gate1', paths, now: NOW, env: emptyEnv })
    expect(onOut).toContain('waiting for endpoint')

    // 4) /grammar ask and /grammar review refuse clearly with ENDPOINT_REQUIRED_MESSAGE.
    const askOut = await runCommand({ args: 'ask why did I miss articles?', conversationId: 'gate1', paths, now: NOW, env: emptyEnv, completer: m.fn })
    expect(askOut).toContain(ENDPOINT_REQUIRED_MESSAGE)
    expect(m.prompts.length).toBe(0)

    // Seed 20 fixes via temporary endpoint in reply mode, then unset endpoint to verify /grammar review refusal.
    await runCommand({ args: 'config display reply', conversationId: 'gate1', paths, now: NOW, env: emptyEnv })
    await runCommand({ args: 'config endpoint http://mock.local', conversationId: 'gate1', paths, now: NOW, env: emptyEnv })
    for (let i = 0; i < 20; i++) {
      await handleHook(
        { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'gate1', lastUserInput: `it will appea here ${i}` },
        { env: emptyEnv, completer: m.fn, now: NOW - (20 - i) * 60_000 },
      )
    }
    await runCommand({ args: 'config endpoint unset', conversationId: 'gate1', paths, now: NOW, env: emptyEnv })
    const revOut = await runCommand({ args: 'review', conversationId: 'gate1', paths, now: NOW, env: emptyEnv, completer: m.fn })
    expect(revOut).toContain(ENDPOINT_REQUIRED_MESSAGE)
  })

  test('calls configured OpenAI-compatible HTTP endpoint end-to-end', async () => {
    const freshEnv: Record<string, string | undefined> = { ...env, PROMPT_GRAMMAR_CONFIG_DIR: join(tmpDir, 'http-config') }
    const paths = resolvePaths(undefined, freshEnv)
    let hits = 0
    const server = createServer((_req, res) => {
      hits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  english: true,
                  fixes: [{ from: 'appea', to: 'appear', why: 'typo', kind: 'spelling' }],
                  natural: null,
                }),
              },
            },
          ],
        }),
      )
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const addr = server.address() as { port: number }
      await runCommand({ args: `config endpoint http://127.0.0.1:${addr.port}`, conversationId: 'ep1', paths, now: NOW, env: freshEnv })
      await runCommand({ args: 'config endpoint_model local-test', conversationId: 'ep1', paths, now: NOW, env: freshEnv })

      const r1 = await handleHook(
        { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'ep1', lastUserInput: 'it should appea here' },
        { env: freshEnv, now: NOW },
      )
      const r2 = await handleHook(
        { hookEventName: 'PreInvocation', invocationNum: 0, conversationId: 'ep1', lastUserInput: 'it should appea now' },
        { env: freshEnv, now: NOW + 10 },
      )
      expect((r1.injectSteps?.[0] as { systemMessage?: { systemMessage: string } })?.systemMessage?.systemMessage).toContain('~~appea~~ **appear**')
      expect((r2.injectSteps?.[0] as { systemMessage?: { systemMessage: string } })?.systemMessage?.systemMessage).toContain('~~appea~~ **appear**')
      expect(hits).toBe(2)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
