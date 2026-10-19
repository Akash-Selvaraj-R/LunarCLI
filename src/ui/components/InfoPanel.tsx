import { Box, Text } from 'ink'

import type { LunarConfig } from '../../config/schema.js'
import type { Workspace } from '../../domain/types/workspace.js'
import { theme } from '../theme.js'
import { infoRow } from '../styles.js'

export interface InfoPanelProps {
  workspace: Workspace
  config: LunarConfig
  version: string
}

/**
 * Key/value status lines shown under the header.
 */
export function InfoPanel({ workspace, config, version }: InfoPanelProps) {
  const rows: string[] = [infoRow('workspace', theme.text(workspace.name))]

  if (workspace.git.isRepository) {
    rows.push(infoRow('git', `${theme.success('✓')} repository`))
    if (workspace.git.branch !== undefined) {
      rows.push(infoRow('branch', theme.text(workspace.git.branch)))
    }
  } else {
    rows.push(infoRow('git', theme.muted('— not a repository')))
  }

  rows.push(infoRow('version', theme.text(version)))
  rows.push(
    infoRow(
      'provider',
      config.provider !== undefined ? theme.text(config.provider) : theme.muted('not configured'),
    ),
  )
  if (config.model !== undefined) {
    rows.push(infoRow('model', theme.text(config.model)))
  }
  if (config.debug) {
    rows.push(infoRow('debug', theme.warning('enabled')))
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((row) => (
        <Text key={row}>{row}</Text>
      ))}
    </Box>
  )
}
