/**
 * CVE-2026-111768 / GHSA-46jr-4wx8-v453 (WYREAI-454): tool-argument element cap.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_TOOL_INPUT_ELEMENTS,
  countToolInputElements,
  toolInputTooLarge,
  toolInputTooLargeResult,
} from "../input-limits.js";
import { createMcpServer } from "../mcp-server.js";

describe("countToolInputElements", () => {
  it("exposes the documented limits", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(262144);
    expect(MAX_TOOL_INPUT_ELEMENTS).toBe(10_000);
  });

  it("counts scalars as zero", () => {
    expect(countToolInputElements("x", 10)).toBe(0);
    expect(countToolInputElements(null, 10)).toBe(0);
    expect(countToolInputElements(undefined, 10)).toBe(0);
  });

  it("counts array elements and object keys at every depth", () => {
    // keys a,b,c (3); [1,[2,3]] (2) + inner (2); {d:1} (1)
    const value = { a: [1, [2, 3]], b: { d: 1 }, c: "s" };
    expect(countToolInputElements(value, 100)).toBe(3 + 2 + 2 + 1);
  });

  it("exits early once the count exceeds max", () => {
    expect(countToolInputElements(new Array(1_000_000).fill(0), 10)).toBe(11);
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100_000; i++) wide[`k${i}`] = i;
    expect(countToolInputElements(wide, 10)).toBe(11);
  });

  it("does not overflow the stack on very deep nesting", () => {
    let deep: unknown = [];
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(countToolInputElements(deep, MAX_TOOL_INPUT_ELEMENTS)).toBeGreaterThan(
      MAX_TOOL_INPUT_ELEMENTS,
    );
  });

  it("allows exactly the limit and rejects one over", () => {
    expect(toolInputTooLarge(new Array(10).fill(0), 10)).toBe(false);
    expect(toolInputTooLarge(new Array(11).fill(0), 10)).toBe(true);
    expect(toolInputTooLarge({ a: [1, 2, 3] }, 4)).toBe(false);
    expect(toolInputTooLarge({ a: [1, 2, 3] }, 3)).toBe(true);
  });

  it("builds the SDK-shaped error result", () => {
    expect(toolInputTooLargeResult("t")).toEqual({
      content: [
        {
          type: "text",
          text: "Invalid arguments for tool t: arguments contain more than the maximum of 10000 elements",
        },
      ],
      isError: true,
    });
  });
});

describe("createMcpServer tools/call element cap", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function connect(): Promise<Client> {
    const server = createMcpServer({
      baseUrl: "https://cw.example.invalid",
      companyId: "co",
      publicKey: "pub",
      privateKey: "priv",
      clientId: "cid",
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  it("rejects 10_001 nested argument elements with isError", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "cw_search_tickets",
      arguments: { conditions: [new Array(MAX_TOOL_INPUT_ELEMENTS - 1).fill("x")] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("maximum of 10000 elements");
  });
});
