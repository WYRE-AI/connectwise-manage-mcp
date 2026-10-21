/**
 * Request size limits.
 *
 * Mitigates CVE-2026-111768 / GHSA-46jr-4wx8-v453 (memory exhaustion while
 * validating deeply or widely nested tool arguments) and GHSA-f897-62hf-6gxq
 * (no cap on request body / batch size). Tracking: WYREAI-454.
 *
 * Dependency-free so it can be copied verbatim to other fleet repos.
 */

/** Maximum accepted HTTP request body, in bytes (256 KiB). */
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

/** Maximum array elements + object keys, at all depths, in one tool call's arguments. */
export const MAX_TOOL_INPUT_ELEMENTS = 10_000;

/**
 * Count every array element and every own object key at every nesting depth.
 * Iterative (explicit stack) so depth cannot overflow the call stack, and it
 * returns as soon as the running count exceeds `max`.
 */
export function countToolInputElements(value: unknown, max: number): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const item of current) {
        if (++count > max) return count;
        stack.push(item);
      }
    } else {
      const keys = Object.keys(current);
      for (const key of keys) {
        if (++count > max) return count;
        stack.push((current as Record<string, unknown>)[key]);
      }
    }
  }
  return count;
}

export function toolInputTooLarge(args: unknown, max = MAX_TOOL_INPUT_ELEMENTS): boolean {
  return countToolInputElements(args, max) > max;
}

/** Same result the SDK's McpServer `maxToolInputElements` option returns. */
export function toolInputTooLargeResult(toolName: string, max = MAX_TOOL_INPUT_ELEMENTS) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Invalid arguments for tool ${toolName}: arguments contain more than the maximum of ${max} elements`,
      },
    ],
    isError: true as const,
  };
}
