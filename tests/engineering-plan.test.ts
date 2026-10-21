import { describe, expect, it } from 'vitest'

import { isToolError } from '../src/tools/errors.js'
import { parseModelJson } from '../src/engineering/json.js'
import {
  EngineeringPlanSchema,
  classifyStep,
  markSteps,
  withStepStatus,
} from '../src/engineering/plan.js'
import { RetryController } from '../src/engineering/retry.js'
import type { PlanStep } from '../src/engineering/plan.js'

/**
 * Planning + bounded retry (Phase 3).
 *
 * The model's planning output is DATA, validated with Zod: malformed or
 * empty plans are controlled errors, never trusted prose.
 */

const validPlan = {
  goal: 'Add a /health endpoint',
  steps: [
    { id: 'inspect', description: 'Inspect existing API routing' },
    { id: 'implement', description: 'Implement the endpoint' },
    { id: 'test', description: 'Run the tests to verify' },
  ],
}

describe('EngineeringPlanSchema', () => {
  it('parses a valid plan and defaults step status to pending', () => {
    const plan = EngineeringPlanSchema.parse(validPlan)
    expect(plan.goal).toBe('Add a /health endpoint')
    expect(plan.steps).toHaveLength(3)
    expect(plan.steps.every((step) => step.status === 'pending')).toBe(true)
  })

  it('keeps explicit step status and optional fields', () => {
    const plan = EngineeringPlanSchema.parse({
      goal: 'g',
      steps: [
        {
          id: 'a',
          description: 'Inspect the router',
          rationale: 'need the route table',
          tools: ['list_directory'],
          status: 'completed',
        },
      ],
    })
    expect(plan.steps[0]?.status).toBe('completed')
    expect(plan.steps[0]?.rationale).toBe('need the route table')
    expect(plan.steps[0]?.tools).toEqual(['list_directory'])
  })

  it('rejects an empty step list', () => {
    expect(EngineeringPlanSchema.safeParse({ goal: 'g', steps: [] }).success).toBe(false)
  })

  it('rejects a plan without a goal', () => {
    expect(EngineeringPlanSchema.safeParse({ steps: validPlan.steps }).success).toBe(false)
  })

  it('rejects steps without a description', () => {
    const result = EngineeringPlanSchema.safeParse({
      goal: 'g',
      steps: [{ id: 'a' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown step statuses', () => {
    const result = EngineeringPlanSchema.safeParse({
      goal: 'g',
      steps: [{ id: 'a', description: 'd', status: 'done-ish' }],
    })
    expect(result.success).toBe(false)
  })
})

describe('parseModelJson — controlled extraction', () => {
  it('parses a bare JSON object', () => {
    const plan = parseModelJson(JSON.stringify(validPlan), EngineeringPlanSchema, 'plan')
    expect(plan.goal).toBe(validPlan.goal)
  })

  it('parses a fenced JSON object', () => {
    const text = 'Here you go:\n```json\n' + JSON.stringify(validPlan) + '\n```'
    const plan = parseModelJson(text, EngineeringPlanSchema, 'plan')
    expect(plan.steps).toHaveLength(3)
  })

  it('parses JSON embedded in prose', () => {
    const text = `Sure! ${JSON.stringify(validPlan)} Hope that helps.`
    const plan = parseModelJson(text, EngineeringPlanSchema, 'plan')
    expect(plan.goal).toBe(validPlan.goal)
  })

  it('rejects text with no JSON at all', () => {
    try {
      parseModelJson('I think we should just wing it.', EngineeringPlanSchema, 'plan')
      expect.unreachable('expected a ToolError')
    } catch (error) {
      expect(isToolError(error)).toBe(true)
    }
  })

  it('rejects malformed JSON', () => {
    try {
      parseModelJson('{"goal": "g", "steps": [', EngineeringPlanSchema, 'plan')
      expect.unreachable('expected a ToolError')
    } catch (error) {
      expect(isToolError(error)).toBe(true)
    }
  })

  it('rejects valid JSON that violates the schema', () => {
    try {
      parseModelJson('{"goal": "g", "steps": []}', EngineeringPlanSchema, 'plan')
      expect.unreachable('expected a ToolError')
    } catch (error) {
      expect(isToolError(error)).toBe(true)
      expect((error as Error).message).toContain('steps')
    }
  })
})

describe('classifyStep', () => {
  const step = (description: string): PlanStep => ({
    id: 'x',
    description,
    status: 'pending',
  })

  it('classifies inspection steps as research', () => {
    expect(classifyStep(step('Inspect existing API routing'))).toBe('research')
    expect(classifyStep(step('Read the config file'))).toBe('research')
  })

  it('classifies implementation steps as mutation', () => {
    expect(classifyStep(step('Implement the endpoint'))).toBe('mutation')
    expect(classifyStep(step('Add a new file src/health.ts'))).toBe('mutation')
  })

  it('classifies "add tests" as verification, not mutation', () => {
    expect(classifyStep(step('Add tests for the endpoint'))).toBe('verification')
    expect(classifyStep(step('Run the existing test suite'))).toBe('verification')
  })

  it('falls back to other for unrelated steps', () => {
    expect(classifyStep(step('Celebrate with a snack'))).toBe('other')
  })
})

describe('plan progress updates', () => {
  it('withStepStatus updates only the targeted step (immutable)', () => {
    const plan = EngineeringPlanSchema.parse(validPlan)
    const updated = withStepStatus(plan, 'implement', 'completed')
    expect(updated.steps[1]?.status).toBe('completed')
    expect(updated.steps[0]?.status).toBe('pending')
    expect(plan.steps[1]?.status).toBe('pending') // original untouched
  })

  it('markSteps updates every step of the given kinds', () => {
    const plan = EngineeringPlanSchema.parse(validPlan)
    const updated = markSteps(plan, ['verification'], 'failed')
    expect(updated.steps[2]?.status).toBe('failed')
    expect(updated.steps[0]?.status).toBe('pending')
  })
})

describe('RetryController', () => {
  it('consumes attempts until the budget is exhausted', () => {
    const retry = new RetryController(3)
    expect(retry.consume()).toBe(true)
    expect(retry.consume()).toBe(true)
    expect(retry.consume()).toBe(true)
    expect(retry.exhausted).toBe(true)
    expect(retry.consume()).toBe(false)
    expect(retry.attempts).toBe(3)
  })

  it('rejects a non-positive budget', () => {
    expect(() => new RetryController(0)).toThrow(RangeError)
    expect(() => new RetryController(1.5)).toThrow(RangeError)
  })
})
