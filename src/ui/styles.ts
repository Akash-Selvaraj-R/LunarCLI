import type { TextProps } from 'ink'

import { theme } from './theme.js'

/**
 * Shared Ink style primitives used across UI components.
 */

/** Width of the label column in key/value info rows. */
export const INFO_LABEL_WIDTH = 14

/** Default props for dimmed secondary text. */
export const mutedText: TextProps = {
  dimColor: true,
}

/** Render a padded key/value info row. */
export function infoRow(label: string, value: string): string {
  return `${theme.accent(label.padEnd(INFO_LABEL_WIDTH))}${value}`
}
