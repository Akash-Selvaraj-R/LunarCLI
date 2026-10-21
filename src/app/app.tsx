import { Box, Text, useApp, useInput } from 'ink'
import { useRef, useState } from 'react'

import type { Agent } from '../agent/agent.js'
import type { AgentStatus } from '../agent/state.js'
import type { LunarConfig } from '../config/schema.js'
import type { Workspace } from '../domain/types/workspace.js'
import type { Logger } from '../logging/logger.js'
import { Header } from '../ui/components/Header.js'
import { InfoPanel } from '../ui/components/InfoPanel.js'
import { PromptLine } from '../ui/components/PromptLine.js'
import { ThinkingLine, TranscriptLine, type TranscriptEntry } from '../ui/components/Transcript.js'
import { theme } from '../ui/theme.js'

/**
 * LunarCLI application root.
 *
 * Thin presentation layer over the agent runtime: it forwards input to
 * `agent.run()` and renders the emitted events. All business logic
 * (context assembly, provider calls, conversation state) lives in
 * `src/agent/` so it can be tested without Ink.
 */

export interface AppProps {
  config: LunarConfig
  workspace: Workspace
  version: string
  logger: Logger
  /** Configured agent runtime. */
  agent: Agent
  /** Override TTY detection (tests drive the app through a fake terminal). */
  interactive?: boolean
}

/** Whether a chunk of input contains only printable characters. */
function isPrintable(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return false
  }
  return true
}

export function App({
  config,
  workspace,
  version,
  logger,
  agent,
  interactive: interactiveProp,
}: AppProps) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<AgentStatus>('idle')
  const nextIdRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const { exit } = useApp()
  const interactive = interactiveProp ?? process.stdin.isTTY === true
  const busy = status === 'thinking' || status === 'responding'

  const addEntry = (entry: Omit<TranscriptEntry, 'id'>): void => {
    const id = nextIdRef.current++
    setTranscript((previous) => [...previous, { ...entry, id }])
  }

  const submit = (prompt: string): void => {
    const controller = new AbortController()
    controllerRef.current = controller
    addEntry({ kind: 'user', text: prompt })
    setStatus('thinking')

    const assistantId = nextIdRef.current++
    let sawDelta = false

    void agent
      .run(prompt, {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'status') {
            setStatus(event.status)
            return
          }
          if (event.type === 'delta') {
            if (!sawDelta) {
              sawDelta = true
              setTranscript((previous) => [
                ...previous,
                { id: assistantId, kind: 'assistant', text: event.text },
              ])
            } else {
              setTranscript((previous) =>
                previous.map((entry) =>
                  entry.id === assistantId ? { ...entry, text: entry.text + event.text } : entry,
                ),
              )
            }
            return
          }
          if (event.type === 'response') {
            setStatus('idle')
            setTranscript((previous) => {
              const entry: TranscriptEntry = {
                id: assistantId,
                kind: 'assistant',
                text: event.text,
              }
              return previous.some((existing) => existing.id === assistantId)
                ? previous.map((existing) => (existing.id === assistantId ? entry : existing))
                : [...previous, entry]
            })
            return
          }
          if (event.type === 'error') {
            setStatus('idle')
            addEntry({
              kind: 'error',
              text: event.error.message,
              ...(event.error.hint !== undefined ? { hint: event.error.hint } : {}),
            })
            return
          }
          if (event.type === 'cancelled') {
            setStatus('idle')
            addEntry({ kind: 'cancelled', text: 'Request cancelled.' })
          }
        },
      })
      .catch((error: unknown) => {
        // Defensive: the agent contract never rejects, but never leave a spinner up.
        logger.error('Unexpected agent failure', {
          error: error instanceof Error ? error.message : String(error),
        })
        setStatus('idle')
        addEntry({
          kind: 'error',
          text: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        controllerRef.current = null
      })
  }

  useInput(
    (input, key) => {
      // Ctrl+C: cancel an in-flight request; quit when idle.
      if (key.ctrl && input === 'c') {
        if (busy) {
          controllerRef.current?.abort()
          return
        }
        exit()
        return
      }

      // Ctrl+D: exit cleanly (cancelling anything in flight).
      if (key.ctrl && input === 'd') {
        controllerRef.current?.abort()
        exit()
        return
      }

      // Submit.
      if (key.return) {
        const prompt = value.trim()
        if (prompt === '' || busy) return
        logger.debug('Received input', { prompt })
        setValue('')
        submit(prompt)
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
          <TranscriptLine key={entry.id} entry={entry} />
        ))}
        {status === 'thinking' && <ThinkingLine />}
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
