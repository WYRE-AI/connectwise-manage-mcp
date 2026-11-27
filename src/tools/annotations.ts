/**
 * MCP tool annotations advertised on tools/list.
 *
 * Clients such as Claude use readOnlyHint to decide whether a tool is safe to
 * call without an explicit write grant. Every registered ConnectWise tool must
 * carry an explicit readOnlyHint so read tools are not mistaken for writes.
 *
 * openWorldHint is true because every tool talks to the ConnectWise Manage API.
 */

/** GET/list/search/lookup tools that never mutate Manage data. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Creates and additive posts that only add data. */
export const ADDITIVE_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Deletes, removals, JSON Patch updates, moves, and irreversible posts
 * (for example closing a stock adjustment).
 */
export const DESTRUCTIVE_WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;
