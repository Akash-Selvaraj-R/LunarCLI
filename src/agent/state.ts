/**
 * Agent lifecycle states, mirrored by the terminal UI.
 *
 *   idle → thinking → responding → idle
 *                      ↘ error / cancelled → idle
 */
export type AgentStatus = 'idle' | 'thinking' | 'responding' | 'error' | 'cancelled'
