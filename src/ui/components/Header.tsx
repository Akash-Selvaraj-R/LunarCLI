import { Box, Text } from 'ink'

import { theme } from '../theme.js'

/**
 * The Lunar brand header — the crescent mark, restrained and
 * terminal-native. `☾ Lunar` is the product's single terminal identity.
 */
export function Header() {
  return (
    <Box flexDirection="column">
      <Text>
        {theme.brand('☾ Lunar')}
      </Text>
      <Text>{theme.muted('AI SOFTWARE ENGINEERING AGENT')}</Text>
    </Box>
  )
}
