import os from 'node:os'
import path from 'node:path'

/** Expand a leading `~` to the user's home directory. */
export function expandHome(inputPath: string): string {
  if (inputPath === '~') return os.homedir()
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2))
  }
  return inputPath
}

/** Render a path for display, abbreviating the home directory as `~`. */
export function displayPath(inputPath: string): string {
  const home = os.homedir()
  if (inputPath === home) return '~'
  if (inputPath.startsWith(home + path.sep)) {
    return path.join('~', inputPath.slice(home.length + 1))
  }
  return inputPath
}
