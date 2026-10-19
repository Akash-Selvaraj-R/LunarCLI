import { Box, Text } from 'ink'

import { theme } from '../theme.js'

/**
 * The LunarCLI brand header — a restrained lunar/electric identity.
 */
export function Header() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text>
        {theme.brand('◐')} {theme.bold('LUNARCLI')}
      </Text>
      <Text>{theme.muted('AI SOFTWARE ENGINEERING AGENT')}</Text>
    </Box>
  )
}
