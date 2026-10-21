import { z } from 'zod'

/**
 * Structured engineering plans (Phase 3).
 *
 * The model must produce planning DATA, not just prose: every plan is
 * parsed and validated with Zod before the user ever sees it. Invalid
 * output is a controlled error, never silently trusted.
 */

export const PlanStepStatus = {
  PENDING: 'pending',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export type PlanStepStatus = (typeof PlanStepStatus)[keyof typeof PlanStepStatus]

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  rationale: z.string().optional(),
  tools: z.array(z.string().min(1)).optional(),
  status: z.enum(['pending', 'active', 'completed', 'failed']).default('pending'),
})

export const EngineeringPlanSchema = z.object({
  goal: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1),
})

export type PlanStep = z.output<typeof PlanStepSchema>
export type EngineeringPlan = z.output<typeof EngineeringPlanSchema>

/** What kind of loop phase a plan step belongs to (display progress). */
export type StepKind = 'research' | 'mutation' | 'verification' | 'other'

const RESEARCH_WORDS = /\b(inspect|read|review|explore|search|find|identify|examine|analy[sz]e|check the|look)\b/i
const MUTATION_WORDS = /\b(create|write|edit|update|implement|add|modify|change|remove|delete|rename|refactor|fix|patch)\b/i
const VERIFY_WORDS = /\b(tests?|verify|validated?|run tests?|confirm|ensure)\b/i

/**
 * Classify a step by its description for progress display. Heuristic
 * and intentionally simple — it only drives checkmarks in the UI; the
 * loop itself never branches on it.
 */
export function classifyStep(step: PlanStep): StepKind {
  const text = `${step.description} ${step.rationale ?? ''}`
  // Order matters: "add tests" is verification, "add a file" is mutation.
  if (VERIFY_WORDS.test(text) && !MUTATION_WORDS.test(text.replace(/\badd\b[^.]*\btests?\b/i, ''))) {
    if (/\btests?\b/i.test(text) || /\bverify\b/i.test(text)) return 'verification'
  }
  if (RESEARCH_WORDS.test(text)) return 'research'
  if (MUTATION_WORDS.test(text)) return 'mutation'
  if (VERIFY_WORDS.test(text)) return 'verification'
  return 'other'
}

/** Immutably set the status of one step (by id). */
export function withStepStatus(
  plan: EngineeringPlan,
  stepId: string,
  status: PlanStepStatus,
): EngineeringPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => (step.id === stepId ? { ...step, status } : step)),
  }
}

/** Immutably set the status of every step of the given kinds. */
export function markSteps(
  plan: EngineeringPlan,
  kinds: readonly StepKind[],
  status: PlanStepStatus,
): EngineeringPlan {
  const wanted = new Set<string>(kinds)
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      wanted.has(classifyStep(step)) ? { ...step, status } : step,
    ),
  }
}
