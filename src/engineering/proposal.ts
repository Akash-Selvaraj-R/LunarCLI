import { z } from 'zod'

import { FileChangeSchema } from './changes.js'

/**
 * The model's change proposal (Phase 3): a summary, an optional
 * diagnosis (required in effect on retry iterations — the prompt asks
 * for it), and the structured changes. Zod-validated before use.
 */

export const ChangeProposalSchema = z.object({
  /** Root-cause analysis of the previous verification failure. */
  diagnosis: z.string().min(1).optional(),
  /** What this proposal does and why. */
  summary: z.string().min(1),
  changes: z.array(FileChangeSchema).min(1),
})

export type ChangeProposal = z.output<typeof ChangeProposalSchema>
