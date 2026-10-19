import fs from 'node:fs'

/** Whether a path exists. */
export function pathExists(target: string): boolean {
  try {
    fs.statSync(target)
    return true
  } catch {
    return false
  }
}

/** Whether a path exists and is a directory. */
export function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Whether a path exists and is a regular file. */
export function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}
