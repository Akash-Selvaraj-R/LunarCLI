/**
 * File operations supported by the engineering loop (Phase 3).
 *
 * Kept in a leaf module so both the change validator and the diff
 * generator can use it without an import cycle.
 */
export const FileOperation = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
} as const

export type FileOperation = (typeof FileOperation)[keyof typeof FileOperation]
