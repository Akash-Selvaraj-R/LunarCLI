import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentRuntime } from '../src/agent/runtime.js'
import { createSilentLogger } from '../src/logging/logger.js'
import { MockProvider } from '../src/providers/mock.js'
import type { MockProviderOptions } from '../src/providers/mock.js'
import { createDefaultToolRegistry } from '../src/tools/defaults.js'
import type { Workspace } from '../src/domain/types/workspace.js'

/**
 * Attack suite: the model is hostile or broken, the workspace contains
 * secrets, and Lunar must hold the Phase 2 boundary end-to-end through
 * the real agent + real tool registry.
 */

let root: string
let secretOutside: string // a file OUTSIDE the workspace

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-attack-'))
  root = path.join(base, 'workspace')
  secretOutside = path.join(base, 'secret.txt')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = 1;\n')
  fs.writeFileSync(secretOutside, 'SUPER-SECRET-OUTSIDE-CONTENT\n')
})

afterAll(() => {
  try {
    fs.rmSync(path.dirname(root), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function makeAgent(
  script: MockProviderOptions,
  maxToolIterations?: number,
): { agent: AgentRuntime; provider: MockProvider } {
  const provider = new MockProvider(script)
  const workspace: Workspace = { cwd: root, root, name: 'ws', git: { isRepository: false } }
  const agent = new AgentRuntime({
    provider,
    model: provider.defaultModel,
    workspace,
    tools: createDefaultToolRegistry(),
    logger: createSilentLogger(),
    ...(maxToolIterations !== undefined ? { maxToolIterations } : {}),
  })
  return { agent, provider }
}

describe('hostile model — path traversal', () => {
  it('blocks ../ escape and never leaks the outside file', async () => {
    const { agent, provider } = makeAgent({
      script: [
        { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: '../secret.txt' } }] },
        { response: 'I cannot read outside the workspace.' },
      ],
    })
    const result = await agent.run('read the secret', {})

    expect(result.status).toBe('completed')
    const toolMessage = provider.calls[1]?.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('path_outside_workspace')
    // The secret content appears nowhere in the conversation sent to the model.
    const allContent = provider.calls
      .flatMap((call) => call.messages.map((m) => m.content))
      .join('\n')
    expect(allContent).not.toContain('SUPER-SECRET-OUTSIDE-CONTENT')
  })

  it('blocks absolute-path escapes on any platform shape', async () => {
    const escape = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'
    const { agent, provider } = makeAgent({
      script: [
        { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: escape } }] },
        { response: 'No.' },
      ],
    })
    await agent.run('read it', {})
    const toolMessage = provider.calls[1]?.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('path_outside_workspace')
  })

  it('blocks traversal from search and find tools too', async () => {
    for (const args of [
      { query: 'secret', path: '..' },
      { pattern: '**/*', path: '../..' },
    ]) {
      const name = 'query' in args ? 'search_files' : 'find_files'
      const { agent, provider } = makeAgent({
        script: [
          { toolCalls: [{ id: 'c1', name, arguments: args }] },
          { response: 'Cannot search there.' },
        ],
      })
      await agent.run('search outside', {})
      const toolMessage = provider.calls[1]?.messages.find((m) => m.role === 'tool')
      expect(toolMessage?.content).toContain('path_outside_workspace')
    }
  })
})

describe('hostile model — nonexistent and malformed calls', () => {
  it('shell does not exist and never runs', async () => {
    const { agent, provider } = makeAgent({
      script: [
        { toolCalls: [{ id: 'c1', name: 'shell', arguments: { command: 'rm -rf /' } }] },
        { response: 'No shell tool exists.' },
      ],
    })
    await agent.run('run a command', {})
    const toolMessage = provider.calls[1]?.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('Unknown tool: shell')
    // The hint lists only read-only tools.
    expect(toolMessage?.content).not.toContain('run_command')
  })

  it('mutation tools do not exist under any name', async () => {
    for (const name of ['write_file', 'edit_file', 'delete_file', 'git_commit', 'git_push']) {
      const { agent, provider } = makeAgent({
        script: [
          { toolCalls: [{ id: 'c1', name, arguments: { path: 'x' } }] },
          { response: 'Cannot do that.' },
        ],
      })
      await agent.run(`try ${name}`, {})
      const toolMessage = provider.calls[1]?.messages.find((m) => m.role === 'tool')
      expect(toolMessage?.content).toContain('Unknown tool')
    }
  })

  it('malformed arguments never reach the tool', async () => {
    const { agent, provider } = makeAgent({
      script: [
        { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 123 } }] },
        { response: 'That was not a valid call.' },
      ],
    })
    await agent.run('bad args', {})
    const toolMessage = provider.calls[1]?.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('invalid_input')
  })

  it('a runaway tool loop stops at the hard limit', async () => {
    const { agent } = makeAgent(
      { toolCalls: [{ id: 'c', name: 'list_directory', arguments: { path: '.' } }] },
      4,
    )
    const result = await agent.run('loop', {})
    expect(result.status).toBe('completed')
    expect(result.text).toContain('Tool execution limit reached (4')
  })
})

describe('output bounds', () => {
  it('a huge directory is listed with an explicit truncation note', async () => {
    const bigDir = path.join(root, 'many')
    fs.mkdirSync(bigDir)
    for (let index = 0; index < 600; index++) {
      fs.writeFileSync(path.join(bigDir, `file-${String(index).padStart(4, '0')}.txt`), 'x')
    }
    const { agent, provider } = makeAgent({
      script: [
        { toolCalls: [{ id: 'c1', name: 'list_directory', arguments: { path: 'many' } }] },
        { response: 'Truncated listing.' },
      ],
    })
    await agent.run('list everything', {})
    const toolMessage = provider.calls[1]?.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('truncated')
    expect(toolMessage?.content.length).toBeLessThan(200_000)
  })

  it('serialized tool results are capped before reaching the model', async () => {
    // read_file returns up to 2000 lines; a 250 KB single-line file is
    // rejected outright — so build many lines under the byte limit.
    const manyLines = path.join(root, 'lines.txt')
    fs.writeFileSync(manyLines, Array.from({ length: 1_500 }, () => 'abcdefghij').join('\n'))
    const { agent, provider } = makeAgent({
      script: [
        { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'lines.txt' } }] },
        { response: 'Read it.' },
      ],
    })
    await agent.run('read the file', {})
    const toolMessage = provider.calls[1]?.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toContain('"lineCount":1500')
    // And it stays within the serialization cap.
    expect(toolMessage?.content.length ?? 0).toBeLessThan(50_000)
  })
})
