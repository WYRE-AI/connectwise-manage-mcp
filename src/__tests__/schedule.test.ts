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
import worker from "../worker.js";

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

  it("advertises value as required for add and replace only", async () => {
    const response = await worker.fetch(new Request("http://worker.local/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "X-CW-Company-Id": "acme",
        "X-CW-Public-Key": "pub",
        "X-CW-Private-Key": "priv",
        "X-CW-Client-Id": "client-guid",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }), { AUTH_MODE: "gateway" });
    const body = await response.json() as {
      result: { tools: { name: string; inputSchema: {
        properties: { operations: { items: { oneOf: {
          properties: { op: { const: string } };
          required: string[];
        }[] } } };
      } }[] };
    };
    const tool = body.result.tools.find((entry) => entry.name === "cw_update_schedule_entry");
    const requiredByOp = Object.fromEntries(
      tool!.inputSchema.properties.operations.items.oneOf.map((variant) => [
        variant.properties.op.const,
        variant.required,
      ]),
    );
    expect(requiredByOp.add).toEqual(["op", "path", "value"]);
    expect(requiredByOp.replace).toEqual(["op", "path", "value"]);
    expect(requiredByOp.remove).toEqual(["op", "path"]);
  });

  it("marks search and list read-only, create additive, and update as a write", async () => {
    const response = await worker.fetch(new Request("http://worker.local/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "X-CW-Company-Id": "acme",
        "X-CW-Public-Key": "pub",
        "X-CW-Private-Key": "priv",
        "X-CW-Client-Id": "client-guid",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }), { AUTH_MODE: "gateway" });
    const body = await response.json() as {
      result: { tools: { name: string; annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
      } }[] };
    };
    const annotations = Object.fromEntries(
      body.result.tools.map((tool) => [tool.name, tool.annotations]),
    );
    expect(annotations.cw_search_schedule_entries).toMatchObject({ readOnlyHint: true });
    expect(annotations.cw_list_schedule_types).toMatchObject({ readOnlyHint: true });
    expect(annotations.cw_list_schedule_statuses).toMatchObject({ readOnlyHint: true });
    expect(annotations.cw_create_schedule_entry).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(annotations.cw_update_schedule_entry).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });
});
