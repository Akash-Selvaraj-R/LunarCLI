import { z } from 'zod'

import { ToolError } from './errors.js'
import type { Tool } from './types.js'
import type { ToolDefinition } from '../providers/types.js'

/**
 * Registry of tools the agent may invoke.
 *
 * The registry is the single source of truth for what exists: the agent
 * advertises `list()` to the model, and the executor refuses anything
 * `get()` cannot resolve. Phase 2 ships only read-only inspection tools;
 * mutating tools are not registered at all, so their names are safely
 * reported as unknown.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  /** Register a tool. Throws when the name is already taken. */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  /** Whether a tool with this name is registered. */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** Look up a tool by name (undefined when unknown). */
  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /** Look up a tool or throw a structured ToolError. */
  require(name: string): Tool {
    const tool = this.tools.get(name)
    if (tool === undefined) {
      const available = this.list()
        .map((definition) => definition.name)
        .join(', ')
      throw new ToolError('tool_not_found', `Unknown tool: ${name}`, {
        hint: `Available tools: ${available || '(none)'}`,
      })
    }
    return tool
  }

  /** Provider-facing definitions (JSON Schema derived from Zod). */
  list(): readonly ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: `${tool.description} (risk: ${tool.risk})`,
      parameters: z.toJSONSchema(tool.inputSchema, { io: 'input' }),
    }))
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size
  }
}
