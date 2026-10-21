import type { ToolDefinition } from '../providers/types.js'
import type { Tool } from './types.js'

/**
 * Registry of tools the agent may (eventually) invoke.
 *
 * Phase 1: the default registry is EMPTY, and the runtime refuses any
 * tool call the model emits — nothing executes.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  /** Register a tool. Throws when the name is already taken. */
  register(tool: Tool): void {
    const name = tool.definition.name
    if (this.tools.has(name)) {
      throw new Error(`Tool already registered: ${name}`)
    }
    this.tools.set(name, tool)
  }

  /** Whether a tool with this name is registered. */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** Look up a tool by name (undefined when unknown). */
  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /** Tool definitions to advertise to the model (empty in Phase 1). */
  list(): readonly ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition)
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size
  }
}
