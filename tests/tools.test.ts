import { describe, expect, it } from 'vitest'

import { ToolRegistry } from '../src/tools/registry.js'
import type { Tool } from '../src/tools/types.js'
import type { ToolCall, ToolResult } from '../src/domain/types/index.js'

/** A tool that records whether it was ever executed. */
function countingTool(name: string): { tool: Tool; executions: ToolCall[] } {
  const executions: ToolCall[] = []
  const tool: Tool = {
    definition: { name, description: `${name} tool`, parameters: { type: 'object' } },
    execute: async (call: ToolCall): Promise<ToolResult> => {
      executions.push(call)
      return { toolCallId: call.id, success: true, output: 'ok' }
    },
  }
  return { tool, executions }
}

describe('ToolRegistry', () => {
  it('starts empty — Phase 1 has no executable tools', () => {
    const registry = new ToolRegistry()
    expect(registry.size).toBe(0)
    expect(registry.list()).toEqual([])
    expect(registry.has('shell')).toBe(false)
    expect(registry.get('shell')).toBeUndefined()
  })

  it('registers tools and exposes their definitions', () => {
    const registry = new ToolRegistry()
    const { tool } = countingTool('read_file')
    registry.register(tool)

    expect(registry.size).toBe(1)
    expect(registry.has('read_file')).toBe(true)
    expect(registry.get('read_file')).toBe(tool)
    expect(registry.list()).toEqual([
      { name: 'read_file', description: 'read_file tool', parameters: { type: 'object' } },
    ])
  })

  it('rejects duplicate tool names', () => {
    const registry = new ToolRegistry()
    registry.register(countingTool('dup').tool)
    expect(() => registry.register(countingTool('dup').tool)).toThrow(/already registered/)
  })

  it('returns undefined for unknown tools instead of throwing', () => {
    const registry = new ToolRegistry()
    expect(registry.get('nope')).toBeUndefined()
    expect(registry.has('nope')).toBe(false)
  })

  it('executes nothing on its own — registration is inert', async () => {
    const registry = new ToolRegistry()
    const { tool, executions } = countingTool('shell')
    registry.register(tool)
    // The agent runtime never calls execute() in Phase 1.
    expect(executions).toHaveLength(0)
  })
})
