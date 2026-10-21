import { Box, Text } from 'ink'

import { theme } from '../theme.js'

export interface PromptLineProps {
  /** Current contents of the input line. */
  value: string
  /** Set to false in non-TTY environments (static cursor, no input). */
  interactive: boolean
}

/**
 * The `☾ Lunar ›` prompt line with a block cursor.
 */
export function PromptLine({ value, interactive }: PromptLineProps) {
  return (
    <Box marginTop={1}>
      <Text>
        {theme.brand('☾ Lunar')} {theme.dim('›')} {value}
        {interactive ? <Text inverse> </Text> : theme.dim('_')}
      </Text>
    </Box>
  )
}
