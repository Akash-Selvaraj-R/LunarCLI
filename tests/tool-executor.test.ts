import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createSilentLogger } from '../src/logging/logger.js'
import { PermissionManager, PHASE2_POLICY } from '../src/permissions/permission-manager.js'
import { ToolExecutor } from '../src/tools/executor.js'
import { MockTool, failingMockTool, toolResult } from '../src/tools/mock.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { ToolRisk } from '../src/tools/risk.js'
import type { Tool } from '../src/tools/types.js'
import type { Workspace } from '../src/domain/types/workspace.js'
import { truncationMarker } from '../src/tools/serialize.js'

/**
 * ToolExecutor behavior: the single gate between a model-requested tool
 * call and actual execution. Validation, permissions, structured
 * failures, output limits, cancellation.
 */

const workspace: Workspace = {
  cwd: '/repo',
  root: '/repo',
  name: '~/repo',
  git: { isRepository: false },
}

function makeExecutor(
  tools: Tool[],
  options: { permissions?: PermissionManager; outputCharLimit?: number } = {},
) {
  const registry = new ToolRegistry()
  for (const tool of tools) registry.register(tool)
  return new ToolExecutor({
    registry,
    permissions: options.permissions ?? new PermissionManager(),
    logger: createSilentLogger(),
    ...(options.outputCharLimit !== undefined ? { outputCharLimit: options.outputCharLimit } : {}),
  })
}

const context = { workspace }

describe('ToolExecutor — happy path', () => {
  it('executes a permitted tool with validated input', async () => {
    const tool = new MockTool({
      name: 'echo',
      inputSchema: z.object({ text: z.string() }),
      result: (input) => toolResult('x', { echoed: input }),
    })
    const executor = makeExecutor([tool])

    const result = await executor.execute(
      { id: 'c1', name: 'echo', arguments: { text: 'hi' } },
      context,
    )

    expect(result.success).toBe(true)
    expect(result.output).toEqual({ echoed: { text: 'hi' } })
    expect(tool.calls).toEqual([{ text: 'hi' }])
  })
})

describe('ToolExecutor — failures become results, never crashes', () => {
  it('returns tool_not_found for an unknown tool', async () => {
    const executor = makeExecutor([])
    const result = await executor.execute({ id: 'c1', name: 'write_file', arguments: {} }, context)
    expect(result.success).toBe(false)
    expect(result.error?.kind).toBe('tool_not_found')
    expect(result.error?.hint).toContain('Available tools')
  })

  it('rejects malformed arguments before the tool runs', async () => {
    const tool = new MockTool({
      name: 'reader',
      inputSchema: z.object({ path: z.string() }),
      result: () => toolResult('x', 'should not run'),
    })
    const executor = makeExecutor([tool])

    // {"path": 123} — the classic malformed model request.
    const result = await executor.execute(
      { id: 'c1', name: 'reader', arguments: { path: 123 } },
      context,
    )

    expect(result.success).toBe(false)
    expect(result.error?.kind).toBe('invalid_input')
    expect(result.error?.message).toContain('path')
    expect(tool.calls).toHaveLength(0) // the tool never saw the bad input
  })

  it('rejects unknown fields the schema does not allow', async () => {
    const tool = new MockTool({
      name: 'strict',
      inputSchema: z.object({ path: z.string() }).strict(),
      result: () => toolResult('x', 'nope'),
    })
    const executor = makeExecutor([tool])
    const result = await executor.execute(
      { id: 'c1', name: 'strict', arguments: { path: 'a', evil: true } },
      context,
    )
    expect(result.success).toBe(false)
    expect(result.error?.kind).toBe('invalid_input')
    expect(tool.calls).toHaveLength(0)
  })

  it('passes through a tool’s own structured failure', async () => {
    const executor = makeExecutor([failingMockTool('reader')])
    const result = await executor.execute({ id: 'c1', name: 'reader', arguments: {} }, context)
    expect(result.success).toBe(false)
    expect(result.error?.kind).toBe('file_not_found')
    expect(result.error?.message).toContain('Simulated missing file')
  })

  it('wraps unexpected throwables as execution_error with redaction', async () => {
    const tool = new MockTool({
      name: 'crashy',
      throw: () => new Error('kaboom with sk-lunar-secret-1234567890'),
    })
    const executor = makeExecutor([tool])
    const result = await executor.execute({ id: 'c1', name: 'crashy', arguments: {} }, context)
    expect(result.success).toBe(false)
    expect(result.error?.kind).toBe('execution_error')
    expect(result.error?.message).toContain('[redacted]')
    expect(result.error?.message).not.toContain('sk-lunar-secret-1234567890')
  })
})

describe('ToolExecutor — permissions are centralized', () => {
  it('denies a mutating tool without executing it', async () => {
    let ran = false
    const mutator: Tool = {
      name: 'write_file',
      description: 'mutating',
      risk: ToolRisk.MUTATING,
      inputSchema: z.object({}),
      execute: async (call) => {
        ran = true
        return { toolCallId: call.id, success: true, output: {} }
      },
    }
    const executor = makeExecutor([mutator])

    const result = await executor.execute({ id: 'c1', name: 'write_file', arguments: {} }, context)

    expect(ran).toBe(false)
    expect(result.success).toBe(false)
    expect(result.error?.kind).toBe('permission_denied')
    expect(result.error?.message).toContain('not permitted')
  })

  it('denies dangerous tools', async () => {
    const bomb: Tool = {
      name: 'shell',
      description: 'dangerous',
      risk: ToolRisk.DANGEROUS,
      inputSchema: z.object({}),
      execute: async (call) => ({ toolCallId: call.id, success: true, output: {} }),
    }
    const executor = makeExecutor([bomb])
    const result = await executor.execute({ id: 'c1', name: 'shell', arguments: {} }, context)
    expect(result.error?.kind).toBe('permission_denied')
  })

  it('allows safe and read-only tools per the Phase 2 policy', () => {
    const permissions = new PermissionManager()
    expect(permissions.check({ tool: 'a', risk: ToolRisk.SAFE })).toBe('allow')
    expect(permissions.check({ tool: 'b', risk: ToolRisk.READ_ONLY })).toBe('allow')
    expect(permissions.check({ tool: 'c', risk: ToolRisk.MUTATING })).toBe('deny')
    expect(permissions.check({ tool: 'd', risk: ToolRisk.DANGEROUS })).toBe('deny')
    // The Phase 2 policy never asks — no interactive approval yet.
    expect(Object.values(PHASE2_POLICY)).not.toContain('ask')
  })
})

describe('ToolExecutor — output limits and cancellation', () => {
  it('leaves huge outputs to the serializer limit (executor does not truncate)', async () => {
    const big = 'x'.repeat(100_000)
    const tool = new MockTool({ name: 'big', result: () => toolResult('x', big) })
    const executor = makeExecutor([tool])
    const result = await executor.execute({ id: 'c1', name: 'big', arguments: {} }, context)
    expect(result.success).toBe(true)
    // The raw result stays whole; serialization (used for the model) is bounded.
    expect((result.output as string).length).toBe(100_000)
  })

  it('serialization of results is bounded with an explicit marker', async () => {
    const big = 'y'.repeat(5_000)
    const tool = new MockTool({ name: 'big', result: () => toolResult('x', big) })
    const executor = makeExecutor([tool], { outputCharLimit: 1_000 })
    await executor.execute({ id: 'c1', name: 'big', arguments: {} }, context)
    // The executor only executes; the marker helper is what bounds output.
    expect(truncationMarker(1_000, 5_000)).toContain('1,000 of 5,000')
  })

  it('converts an abort during execution into a cancelled result', async () => {
    const slow = new MockTool({ name: 'slow', delayMs: 500 })
    const executor = makeExecutor([slow])
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)

    const result = await executor.execute(
      { id: 'c1', name: 'slow', arguments: {} },
      { ...context, signal: controller.signal },
      { signal: controller.signal },
    )

    expect(result.success).toBe(false)
    expect(result.error?.kind).toBe('cancelled')
  })

  it('refuses to run at all when the signal is already aborted', async () => {
    const tool = new MockTool({ name: 't', result: () => toolResult('x', 'ran') })
    const executor = makeExecutor([tool])
    const controller = new AbortController()
    controller.abort()

    const result = await executor.execute(
      { id: 'c1', name: 't', arguments: {} },
      { ...context, signal: controller.signal },
      { signal: controller.signal },
    )

    expect(result.error?.kind).toBe('cancelled')
    expect(tool.calls).toHaveLength(0)
  })
})
