import { Box, Text } from 'ink'

import { theme } from '../theme.js'

/** One rendered line group in the conversation transcript. */
export interface TranscriptEntry {
  id: number
  kind: 'user' | 'assistant' | 'error' | 'cancelled' | 'tool_call' | 'tool_result'
  text: string
  /** Optional actionable hint, shown dimmed under an error. */
  hint?: string
  /** Compact argument summary for tool_call entries. */
  args?: string
}

export interface TranscriptLineProps {
  entry: TranscriptEntry
}

/**
 * A single transcript entry.
 *
 * Layout mirrors the Lunar aesthetic: the user speaks at the `☾ Lunar ›`
 * prompt, the model answers as `Lunar ›`, tool activity is a compact
 * `◇ tool` / `✓ result` pair, failures show `✗` plus a hint.
 */
export function TranscriptLine({ entry }: TranscriptLineProps) {
  if (entry.kind === 'user') {
    return (
      <Text>
        {theme.brand('☾ Lunar')} {theme.dim('›')} {entry.text}
      </Text>
    )
  }
  if (entry.kind === 'assistant') {
    return (
      <Text>
        {theme.brand('Lunar')} {theme.dim('›')} {entry.text}
      </Text>
    )
  }
  if (entry.kind === 'tool_call') {
    return (
      <Box flexDirection="column">
        <Text>
          {theme.accent('◇')} {entry.text}
        </Text>
        {entry.args !== undefined && entry.args !== '' && (
          <Text>{theme.muted(`  ${entry.args}`)}</Text>
        )}
      </Box>
    )
  }
  if (entry.kind === 'tool_result') {
    return (
      <Text>
        {theme.success('✓')} {theme.muted(entry.text)}
      </Text>
    )
  }
  if (entry.kind === 'error') {
    return (
      <Box flexDirection="column">
        <Text>
          {theme.error('✗')} {entry.text}
        </Text>
        {entry.hint !== undefined && <Text>{theme.muted(entry.hint)}</Text>}
      </Box>
    )
  }
  return <Text>{theme.muted(entry.text)}</Text>
}

/**
 * The in-flight indicator: `☾ thinking...` while waiting for the model,
 * gone once the first streamed token arrives.
 */
export function ThinkingLine() {
  return (
    <Text>
      {theme.brand('☾')} {theme.muted('thinking...')}
    </Text>
  )
}
