import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import type { Logger } from '../logging/logger.js'
import { createSilentLogger } from '../logging/logger.js'
import { redactText } from '../utils/redact.js'
import type { EngineeringLimits } from './limits.js'
import type { ValidatedChange } from './changes.js'
import { FileOperation } from './changes.js'

/**
 * MutationManager — the ONLY code path that writes to disk (Phase 3).
 *
 * Inputs are already workspace-validated `ValidatedChange`s (the loop
 * validates, the user approves). This layer applies them safely:
 *
 * - atomic writes: temp file in the same directory → write → rename.
 *   A crash mid-write never leaves a half-written target.
 * - single files only: no directories, no recursion.
 * - sequential with stop-on-first-error: later changes are reported as
 *   skipped so the user sees exactly what happened.
 * - abortable between changes; a failure never throws out of `apply`.
 */

export interface ApplyResult {
  readonly change: ValidatedChange
  readonly applied: boolean
  readonly durationMs: number
  /** Present when applied is false. */
  readonly error?: string
}

export interface MutationManagerOptions {
  limits: EngineeringLimits
  logger?: Logger
}

export class MutationManager {
  private readonly limits: EngineeringLimits
  private readonly logger: Logger

  constructor(options: MutationManagerOptions) {
    this.limits = options.limits
    this.logger = options.logger ?? createSilentLogger()
  }

  /** Apply validated changes in order. Never throws. */
  async apply(
    changes: readonly ValidatedChange[],
    options: { signal?: AbortSignal } = {},
  ): Promise<ApplyResult[]> {
    const results: ApplyResult[] = []
    let failed = false

    for (const change of changes) {
      if (failed || options.signal?.aborted === true) {
        results.push({
          change,
          applied: false,
          durationMs: 0,
          error: options.signal?.aborted === true ? 'cancelled' : 'skipped after earlier failure',
        })
        continue
      }

      const startedAt = Date.now()
      try {
        this.applyOne(change)
        const durationMs = Date.now() - startedAt
        this.logger.debug('Change applied', {
          operation: change.operation,
          target: change.path,
          risk: 'mutating',
          approval: 'granted',
          result: 'ok',
          durationMs,
        })
        results.push({ change, applied: true, durationMs })
      } catch (error) {
        failed = true
        const message = redactText(error instanceof Error ? error.message : String(error))
        this.logger.warn('Change failed', {
          operation: change.operation,
          target: change.path,
          error: message,
        })
        results.push({ change, applied: false, durationMs: Date.now() - startedAt, error: message })
      }
    }
    return results
  }

  /** Apply one change: atomic write, or bounded single-file delete. */
  private applyOne(change: ValidatedChange): void {
    switch (change.operation) {
      case FileOperation.CREATE:
      case FileOperation.UPDATE: {
        // Defense in depth: validation already capped the size; the
        // single write chokepoint refuses oversized content as well.
        const content = change.content ?? ''
        if (Buffer.byteLength(content, 'utf8') > this.limits.maxFileBytes) {
          throw new Error(
            `Refusing to write ${change.path}: content exceeds the ` +
              `${this.limits.maxFileBytes}-byte limit.`,
          )
        }
        atomicWrite(change.absolutePath, content)
        return
      }
      case FileOperation.DELETE: {
        const stat = fs.statSync(change.absolutePath)
        if (!stat.isFile()) {
          throw new Error(`Refusing to delete a non-file path: ${change.path}`)
        }
        fs.unlinkSync(change.absolutePath)
        return
      }
    }
  }
}

/**
 * Atomic write: temp file in the same directory (same filesystem →
 * rename is atomic), then rename over the target. The temp file is
 * removed if anything fails.
 */
export function atomicWrite(absolutePath: string, content: string): void {
  const directory = path.dirname(absolutePath)
  const tempPath = path.join(
    directory,
    `.${path.basename(absolutePath)}.lunar-${process.pid}-${randomBytes(4).toString('hex')}.tmp`,
  )
  try {
    fs.writeFileSync(tempPath, content, 'utf8')
    fs.renameSync(tempPath, absolutePath)
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {
      // Best effort — never mask the original error.
    }
    throw error
  }
}
