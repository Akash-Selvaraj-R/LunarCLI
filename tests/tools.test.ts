import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ToolRegistry } from '../src/tools/registry.js'
import { createDefaultToolRegistry } from '../src/tools/defaults.js'
import { isToolError, ToolError } from '../src/tools/errors.js'
import { ToolRisk } from '../src/tools/risk.js'
import type { Tool } from '../src/tools/types.js'
import type { ToolResult } from '../src/domain/types/index.js'

/** A tool that records how often it was executed. */
function countingTool(name: string): { tool: Tool; state: { executions: number } } {
  const state = { executions: 0 }
  const tool: Tool = {
    name,
    description: `${name} tool`,
    risk: ToolRisk.SAFE,
    inputSchema: z.object({}),
    execute: async (call): Promise<ToolResult> => {
      state.executions += 1
      return { toolCallId: call.id, success: true, output: 'ok' }
    },
  }
  return { tool, state }
}

describe('ToolRegistry', () => {
  it('starts empty — nothing is executable until registered', () => {
    const registry = new ToolRegistry()
    expect(registry.size).toBe(0)
    expect(registry.list()).toEqual([])
    expect(registry.has('shell')).toBe(false)
    expect(registry.get('shell')).toBeUndefined()
  })

  it('registers tools and derives provider definitions from Zod schemas', () => {
    const registry = new ToolRegistry()
    const tool: Tool = {
      name: 'read_file',
      description: 'Read a file',
      risk: ToolRisk.READ_ONLY,
      inputSchema: z.object({ path: z.string() }),
      execute: async (call) => ({ toolCallId: call.id, success: true, output: 'ok' }),
    }
    registry.register(tool)

    expect(registry.size).toBe(1)
    expect(registry.has('read_file')).toBe(true)
    expect(registry.get('read_file')).toBe(tool)

    const definitions = registry.list()
    expect(definitions).toHaveLength(1)
    expect(definitions[0]?.name).toBe('read_file')
    // Risk is visible to the model in the tool description.
    expect(definitions[0]?.description).toContain('read_only')
    // JSON Schema derived from the Zod input schema.
    expect(definitions[0]?.parameters).toMatchObject({ type: 'object' })
    expect(JSON.stringify(definitions[0]?.parameters)).toContain('path')
  })

  it('rejects duplicate tool names', () => {
    const registry = new ToolRegistry()
    const { tool } = countingTool('dup')
    registry.register(tool)
    expect(() => registry.register({ ...tool })).toThrow(/already registered/)
  })

  it('require() throws a structured tool_not_found for unknown tools', () => {
    const registry = new ToolRegistry()
    registry.register(countingTool('read_file').tool)
    try {
      registry.require('write_file')
      expect.unreachable('require should have thrown')
    } catch (error) {
      expect(isToolError(error)).toBe(true)
      expect((error as ToolError).kind).toBe('tool_not_found')
      expect((error as ToolError).message).toContain('write_file')
      expect((error as ToolError).hint).toContain('read_file')
    }
  })

  it('returns undefined for unknown tools instead of throwing', () => {
    const registry = new ToolRegistry()
    expect(registry.get('nope')).toBeUndefined()
    expect(registry.has('nope')).toBe(false)
  })

  it('registration alone never executes anything', async () => {
    const registry = new ToolRegistry()
    const { tool, state } = countingTool('probe')
    registry.register(tool)
    expect(state.executions).toBe(0)
  })
})

describe('createDefaultToolRegistry (Phase 2 tool set)', () => {
  const registry = createDefaultToolRegistry()

  it('contains exactly the read-only inspection tools', () => {
    const names = registry
      .list()
      .map((definition) => definition.name)
      .sort()
    expect(names).toEqual([
      'file_exists',
      'find_files',
      'git_branch',
      'git_diff',
      'git_log',
      'git_status',
      'list_directory',
      'read_file',
      'search_files',
    ])
  })

  it('never registers a shell or mutation tool', () => {
    for (const forbidden of [
      'shell',
      'run_command',
      'exec',
      'write_file',
      'edit_file',
      'create_file',
      'delete_file',
      'move_file',
      'copy_file',
      'git_commit',
      'git_push',
      'git_checkout',
      'git_reset',
    ]) {
      expect(registry.has(forbidden), `${forbidden} must not be registered`).toBe(false)
    }
  })

  it('classifies every registered tool with an allowed risk level', () => {
    for (const definition of registry.list()) {
      expect(definition.description).toMatch(/\(risk: (safe|read_only)\)$/)
    }
  })
})
