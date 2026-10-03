/**
 * Tests for the schedule entry tools.
 *
 * The update tool sends JSON Patch to ConnectWise, so the schema has to refuse
 * an add or replace with no value before it reaches the API.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CwManageClient } from "../api-client.js";
import { registerScheduleTools } from "../tools/schedule.js";

function updateSchema() {
  let shape: z.ZodRawShape | undefined;
  const server = {
    tool(name: string, _description: string, schema: z.ZodRawShape) {
      if (name === "cw_update_schedule_entry") shape = schema;
    },
  };
  registerScheduleTools(server as unknown as McpServer, {} as unknown as CwManageClient);
  if (!shape) throw new Error("cw_update_schedule_entry not registered");
  return z.object(shape);
}

describe("cw_update_schedule_entry schema", () => {
  const schema = updateSchema();

  it("rejects replace and add without a value", () => {
    for (const op of ["replace", "add"] as const) {
      const result = schema.safeParse({ id: 1, operations: [{ op, path: "dateStart" }] });
      expect(result.success).toBe(false);
    }
  });

  it("accepts replace with a value, including false and null", () => {
    for (const value of ["2026-10-01T02:00:00Z", false, null]) {
      const result = schema.safeParse({
        id: 1,
        operations: [{ op: "replace", path: "doneFlag", value }],
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts remove without a value", () => {
    const result = schema.safeParse({ id: 1, operations: [{ op: "remove", path: "notes" }] });
    expect(result.success).toBe(true);
  });
});
