/**
 * Bounded self-correction (Phase 3).
 *
 * A tiny explicit counter — the loop can never iterate forever because
 * the budget is enforced by code, not by the model choosing to stop.
 */
export class RetryController {
  private used = 0

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`maxIterations must be a positive integer, got ${max}`)
    }
  }

  /** Attempts consumed so far. */
  get attempts(): number {
    return this.used
  }

  get exhausted(): boolean {
    return this.used >= this.max
  }

  /** Consume one attempt. Returns false when the budget is spent. */
  consume(): boolean {
    if (this.exhausted) return false
    this.used += 1
    return true
  }
}
