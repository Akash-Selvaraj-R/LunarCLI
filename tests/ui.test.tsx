import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import { App } from '../src/app/app.js'
import type { LunarConfig } from '../src/config/schema.js'
import { createSilentLogger } from '../src/logging/logger.js'
import type { Workspace } from '../src/domain/types/workspace.js'

const workspace: Workspace = {
  cwd: '/repo',
  root: '/repo',
  name: '~/repo',
  git: { isRepository: true, root: '/repo', branch: 'main' },
}

const config: LunarConfig = { debug: false }

function renderApp(appConfig: LunarConfig = config): string {
  return renderToString(
    <App config={appConfig} workspace={workspace} version="0.1.0" logger={createSilentLogger()} />,
    { columns: 80 },
  )
}

describe('App (initial screen)', () => {
  it('shows the brand header', () => {
    const output = renderApp()
    expect(output).toContain('◐')
    expect(output).toContain('LUNARCLI')
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
    expect(output).toContain('lunar')
    expect(output).toContain('›')
  })

  it('reflects debug mode and configured provider', () => {
    const output = renderApp({ debug: true, provider: 'openai', model: 'gpt-5' })
    expect(output).toContain('enabled')
    expect(output).toContain('openai')
    expect(output).toContain('gpt-5')
  })
})
