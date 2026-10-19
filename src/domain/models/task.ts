import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { Task, TaskStatus } from '../types/index.js'

export const TASK_STATUSES = [
  'pending',
  'planning',
  'in_progress',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly TaskStatus[]

/** Zod schema mirroring the `Task` domain type, for runtime validation. */
export const TaskSchema = z.object({
  id: z.uuid(),
  prompt: z.string().min(1),
  status: z.enum(TASK_STATUSES),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

/** Create a new task in the `pending` state. */
export function createTask(prompt: string): Task {
  const now = Date.now()
  const task: Task = {
    id: randomUUID(),
    prompt,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }
  return TaskSchema.parse(task)
}

/** Return a copy of the task with a new status and refresh timestamp. */
export function withTaskStatus(task: Task, status: TaskStatus): Task {
  return TaskSchema.parse({ ...task, status, updatedAt: Date.now() })
}
