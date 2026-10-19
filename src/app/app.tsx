import { Box, Text, useApp, useInput } from 'ink'
import { useState } from 'react'

import type { LunarConfig } from '../config/schema.js'
import type { Workspace } from '../domain/types/workspace.js'
import type { Logger } from '../logging/logger.js'
import { Header } from '../ui/components/Header.js'
import { InfoPanel } from '../ui/components/InfoPanel.js'
import { PromptLine } from '../ui/components/PromptLine.js'
import { theme } from '../ui/theme.js'

/**
 * LunarCLI application root.
 *
 * Phase 0 scope: brand header, workspace/status info, and a working input
 * line that acknowledges input without executing anything. The agent loop
 * arrives in Phase 1 — this component is where it will be mounted.
 */

export interface AppProps {
  config: LunarConfig
  workspace: Workspace
  version: string
  logger: Logger
}

interface TranscriptEntry {
  id: number
  kind: 'echo' | 'notice'
  text: string
}

/** Whether a chunk of input contains only printable characters. */
function isPrintable(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return false
  }
  return true
}

const PHASE_ONE_NOTICE = 'Lunar runtime is coming in Phase 1.'

export function App({ config, workspace, version, logger }: AppProps) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [value, setValue] = useState('')
  const [nextId, setNextId] = useState(0)
  const { exit } = useApp()
  const interactive = process.stdin.isTTY === true

  useInput(
    (input, key) => {
      // Graceful shutdown.
      if (key.ctrl && input === 'd') {
        exit()
        return
      }

      // Submit.
      if (key.return) {
        const prompt = value.trim()
        if (prompt === '') return
        logger.debug('Received input', { prompt })
        setTranscript((previous) => [
          ...previous,
          { id: nextId, kind: 'echo', text: prompt },
          { id: nextId + 1, kind: 'notice', text: PHASE_ONE_NOTICE },
        ])
        setNextId(nextId + 2)
        setValue('')
        return
      }

      // Backspace / delete.
      if (key.backspace || key.delete) {
        setValue((previous) => Array.from(previous).slice(0, -1).join(''))
        return
      }

      // Ignore other control keys (arrows, tab, escape, …).
      if (key.ctrl || key.meta) return
      if (input.length > 0 && isPrintable(input)) {
        setValue((previous) => previous + input)
      }
    },
    { isActive: interactive },
  )

  return (
    <Box flexDirection="column">
      <Header />
      <InfoPanel workspace={workspace} config={config} version={version} />

      <Box flexDirection="column" marginTop={1}>
        {transcript.map((entry) => (
          <Text key={entry.id}>
            {entry.kind === 'echo'
              ? `${theme.brand('lunar')} ${theme.dim('›')} ${entry.text}`
              : theme.dim(entry.text)}
          </Text>
        ))}
      </Box>

      {!interactive && (
        <Box marginTop={1}>
          <Text>{theme.muted('interactive input disabled — stdin is not a TTY')}</Text>
        </Box>
      )}

      <PromptLine value={value} interactive={interactive} />
    </Box>
  )
}
