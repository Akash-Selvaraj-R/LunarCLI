import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import { App } from '../src/app/app.js'
import { AgentRuntime } from '../src/agent/runtime.js'
import type { LunarConfig } from '../src/config/schema.js'
import { createSilentLogger } from '../src/logging/logger.js'
import { MockProvider } from '../src/providers/mock.js'
import type { Workspace } from '../src/domain/types/workspace.js'

const workspace: Workspace = {
  cwd: '/repo',
  root: '/repo',
  name: '~/repo',
  git: { isRepository: true, root: '/repo', branch: 'main' },
}

const config: LunarConfig = { debug: false }

function makeAgent(provider = new MockProvider()): AgentRuntime {
  return new AgentRuntime({ provider, model: provider.defaultModel, workspace })
}

function renderApp(
  appConfig: LunarConfig = config,
  provider: MockProvider = new MockProvider(),
): string {
  return renderToString(
    <App
      config={appConfig}
      workspace={workspace}
      version="0.1.0"
      logger={createSilentLogger()}
      agent={makeAgent(provider)}
    />,
    { columns: 80 },
  )
}

describe('App (initial screen)', () => {
  it('shows the brand header', () => {
    const output = renderApp()
    expect(output).toContain('☾')
    expect(output).toContain('Lunar')
    expect(output).toContain('AI SOFTWARE ENGINEERING AGENT')
  })

  it('shows workspace, git, version, and provider status', () => {
    const output = renderApp()
    expect(output).toContain('workspace')
    expect(output).toContain('~/repo')
    expect(output).toContain('main')
    expect(output).toContain('0.1.0')
    expect(output).toContain('not configured')
  })

  it('shows the prompt line', () => {
    const output = renderApp()
    expect(output).toContain('☾ Lunar')
    expect(output).toContain('›')
  })

  it('reflects debug mode and configured provider', () => {
    const output = renderApp({ debug: true, provider: 'openai', model: 'gpt-5' })
    expect(output).toContain('enabled')
    expect(output).toContain('openai')
    expect(output).toContain('gpt-5')
  })

  it('starts idle — no transcript, no thinking indicator', () => {
    const output = renderApp()
    expect(output).not.toContain('thinking...')
    // The prompt line renders, but no assistant transcript entry does —
    // the mock provider's response never appears.
    expect(output).toContain('☾ Lunar')
    expect(output).not.toContain('Mock response')
  })

  it('disables interactive input when stdin is not a TTY', () => {
    // Vitest runs without a TTY on stdin, so the static notice must show.
    const output = renderApp()
    expect(output).toContain('interactive input disabled')
  })
})
