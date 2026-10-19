/**
 * Minimal ANSI helpers and the LunarCLI color palette.
 *
 * Kept dependency-free: the product identity is a restrained lunar/electric
 * look, so a handful of color functions are all we need. All helpers respect
 * the `NO_COLOR` convention.
 */

const ESC = String.fromCharCode(27)

const noColor =
  process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '' && process.env.NO_COLOR !== '0'

function wrap(open: number, close: number) {
  return (text: string): string => (noColor ? text : `${ESC}[${open}m${text}${ESC}[${close}m`)
}

const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
}

const color = {
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  white: wrap(37, 39),
  gray: wrap(90, 39),
}

/** The LunarCLI palette — lunar white on electric blue/cyan. */
export const theme = {
  /** Brand cyan, bold — used for the logo and prompt. */
  brand: (text: string) => style.bold(color.cyan(text)),
  /** Electric blue accent for labels and highlights. */
  accent: color.blue,
  /** Bright lunar white for primary text. */
  text: color.white,
  /** Dim gray for secondary information. */
  muted: color.gray,
  dim: style.dim,
  bold: style.bold,
  italic: style.italic,
  success: color.green,
  warning: color.yellow,
  error: color.red,
  /** Plain (uncolored) text passthrough. */
  plain: (text: string) => text,
} as const
