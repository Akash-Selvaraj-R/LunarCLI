import { describe, expect, it } from 'vitest'

import { classifyCommand, HARD_DENY_EXECUTABLES } from '../src/security/classifier.js'
import type { CommandRisk } from '../src/security/classifier.js'
import { normalizeCommand } from '../src/security/normalizer.js'
import { isNetworkArgument } from '../src/security/network-policy.js'

/**
 * Per-command risk classification (Phase 4 security matrix): the unit
 * is the normalized command — executable AND arguments — never the bare
 * executable.
 */

function classify(executable: string, args: string[] = []): CommandRisk {
  return classifyCommand(normalizeCommand({ executable, args })).risk
}

describe('classifyCommand — the executable is not the command', () => {
  it('classifies npm subcommands individually', () => {
    expect(classify('npm', ['test'])).toBe('safe')
    expect(classify('npm', ['run', 'lint'])).toBe('safe')
    expect(classify('npm', ['run', 'build'])).toBe('safe')
    expect(classify('npm', ['run', 'deploy-script'])).toBe('review')
    expect(classify('npm', ['install'])).toBe('review')
    expect(classify('npm', ['ci'])).toBe('review')
    expect(classify('npm', ['exec', 'evil-tool'])).toBe('dangerous')
    expect(classify('npm', ['publish'])).toBe('denied')
    expect(classify('npm', ['login'])).toBe('denied')
    expect(classify('npm', ['explore'])).toBe('denied')
  })

  it('classifies git subcommands individually', () => {
    expect(classify('git', ['status'])).toBe('safe')
    expect(classify('git', ['diff'])).toBe('safe')
    expect(classify('git', ['log'])).toBe('safe')
    expect(classify('git', ['branch'])).toBe('safe')
    expect(classify('git', ['stash', 'list'])).toBe('safe')
    expect(classify('git', ['push'])).toBe('denied')
    expect(classify('git', ['push', 'origin', 'main'])).toBe('denied')
    expect(classify('git', ['commit', '-m', 'x'])).toBe('denied')
    expect(classify('git', ['reset', '--hard'])).toBe('denied')
    expect(classify('git', ['checkout'])).toBe('denied')
    expect(classify('git', ['stash', 'pop'])).toBe('denied')
    expect(classify('git', ['branch', '-D', 'feature'])).toBe('dangerous')
    expect(classify('git', ['config', 'core.editor', 'evil'])).toBe('dangerous')
    expect(classify('git', ['clone', 'https://host/repo'])).toBe('denied')
  })

  it('classifies interpreters by how they are invoked', () => {
    expect(classify('node', ['--version'])).toBe('safe')
    expect(classify('node', ['script.js'])).toBe('review')
    expect(classify('node', ['-e', 'process.exit(0)'])).toBe('dangerous')
    expect(classify('node', ['--eval', 'x'])).toBe('dangerous')
    expect(classify('python', ['--version'])).toBe('safe')
    expect(classify('python', ['-m', 'pytest'])).toBe('safe')
    expect(classify('python', ['script.py'])).toBe('review')
    expect(classify('python', ['-c', 'print(1)'])).toBe('dangerous')
    expect(classify('python', ['-m', 'http.server'])).toBe('dangerous')
  })

  it('classifies test and build tooling', () => {
    expect(classify('vitest', ['run'])).toBe('safe')
    expect(classify('cargo', ['test'])).toBe('safe')
    expect(classify('cargo', ['build'])).toBe('review')
    expect(classify('cargo', ['run'])).toBe('dangerous')
    expect(classify('cargo', ['publish'])).toBe('denied')
    expect(classify('go', ['test', './...'])).toBe('safe')
    expect(classify('go', ['build'])).toBe('review')
    expect(classify('go', ['run', 'main.go'])).toBe('dangerous')
    expect(classify('make', ['test'])).toBe('safe')
    expect(classify('make', ['deploy-production'])).toBe('review')
  })

  it('treats npx/npm exec as install-and-execute', () => {
    expect(classify('npx', [' cowsay ', 'hi'])).toBe('dangerous')
    expect(classify('npx', ['--version'])).toBe('safe')
  })

  it('falls back to review for unknown executables', () => {
    expect(classify('definitely-custom-tool', ['build'])).toBe('review')
  })
})

describe('classifyCommand — argument-sensitive escalation', () => {
  it('escalates safe commands carrying URL arguments (network vector)', () => {
    const classification = classifyCommand(
      normalizeCommand({ executable: 'go', args: ['test', 'https://evil.example/pkg'] }),
    )
    expect(classification.risk).toBe('review')
    expect(classification.network).toBe(true)
  })

  it('detects scp-style git remotes as network arguments', () => {
    expect(isNetworkArgument('git@github.com:owner/repo.git')).toBe(true)
    expect(isNetworkArgument('https://example.com/x')).toBe(true)
    expect(isNetworkArgument('./local-file')).toBe(false)
  })

  it('escalates safe commands with force-style flags', () => {
    expect(classify('npm', ['test', '--force'])).toBe('review')
    expect(classify('cargo', ['test', '--unsafe'])).toBe('review')
  })
})

describe('classifyCommand — hard deny', () => {
  it('denies every shell interpreter, however spelled', () => {
    for (const shell of ['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh', 'fish']) {
      expect(classify(shell, ['-c', 'anything'])).toBe('denied')
    }
  })

  it('denies network transfer tools', () => {
    for (const tool of ['curl', 'wget', 'ftp', 'ssh', 'scp', 'rsync', 'nc']) {
      expect(classify(tool, ['https://evil.example/x'])).toBe('denied')
    }
  })

  it('denies LOLBins and destructive OS operations', () => {
    expect(classify('certutil', ['-urlcache', 'x'])).toBe('denied')
    expect(classify('rundll32', [])).toBe('denied')
    expect(classify('mshta', ['x'])).toBe('denied')
    expect(classify('rm', ['-rf', '/'])).toBe('denied')
    expect(classify('format', ['C:'])).toBe('denied')
    expect(classify('sudo', ['anything'])).toBe('denied')
    expect(classify('taskkill', ['/F', '/IM', 'explorer.exe'])).toBe('denied')
  })

  it('denies script hosts and registry tools', () => {
    expect(classify('wscript', ['x.vbs'])).toBe('denied')
    expect(classify('reg', ['import', 'x.reg'])).toBe('denied')
  })

  it('keeps the hard-deny set stable (audit anchor)', () => {
    expect(HARD_DENY_EXECUTABLES.has('bash')).toBe(true)
    expect(HARD_DENY_EXECUTABLES.has('curl')).toBe(true)
    expect(HARD_DENY_EXECUTABLES.has('node')).toBe(false)
    expect(HARD_DENY_EXECUTABLES.has('npm')).toBe(false)
  })
})
