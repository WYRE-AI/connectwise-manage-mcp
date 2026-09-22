/**
 * Tests for the procurement inventory tools.
 *
 * Every test drives the registered tool handlers against a stub client, so no
 * request ever reaches ConnectWise. The write tools in particular are only ever
 * exercised against mocked responses: creating, adding to or closing a real
 * adjustment moves stock and cannot be undone.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CwManageClient } from "../api-client.js";
import { registerProcurementTools } from "../tools/procurement.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

interface RecordedCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  params?: Record<string, string | number | undefined>;
  body?: unknown;
}

/** A GET responder: return the payload for a path, or undefined to fall through. */
type GetResponder = (
  path: string,
  params: Record<string, string | number | undefined>,
) => unknown;

class StubClient {
  calls: RecordedCall[] = [];
  getResponder: GetResponder = () => [];
  postResponse: unknown = { id: 1 };
  patchResponse: unknown = { id: 1, closedFlag: true };

  async get(path: string, params: Record<string, string | number | undefined> = {}) {
    this.calls.push({ method: "GET", path, params });
    return this.getResponder(path, params);
  }

  async post(path: string, body: unknown) {
    this.calls.push({ method: "POST", path, body });
    return this.postResponse;
  }

  async patch(path: string, body: unknown) {
    this.calls.push({ method: "PATCH", path, body });
    return this.patchResponse;
  }

  /** Every GET path recorded, for asserting the bin walk. */
  gets(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "GET");
  }
}

function setup() {
  const tools = new Map<string, { description: string; schema: unknown; handler: Handler }>();
  const server = {
    tool(name: string, description: string, schema: unknown, handler: Handler) {
      tools.set(name, { description, schema, handler });
    },
  };
  const client = new StubClient();

  registerProcurementTools(
    server as unknown as McpServer,
    client as unknown as CwManageClient,
  );

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    const result = await tool.handler(args);
    return JSON.parse(result.content[0].text);
  };

  return { tools, client, call };
}

describe("procurement tool registration", () => {
  it("registers every inventory tool", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual([
      "cw_add_adjustment_detail",
      "cw_close_adjustment",
      "cw_create_adjustment",
      "cw_get_adjustment",
      "cw_get_inventory_on_hand",
      "cw_list_adjustment_types",
      "cw_list_warehouse_bins",
      "cw_list_warehouses",
    ]);
  });

  it("warns on cw_close_adjustment that the post is not reversible", () => {
    const { tools } = setup();
    const description = tools.get("cw_close_adjustment")!.description;
    expect(description).toMatch(/not reversible/i);
    expect(description).toMatch(/counter/i);
  });
});

describe("cw_list_warehouses", () => {
  it("passes conditions through and defaults paging", async () => {
    const { client, call } = setup();
    client.getResponder = () => [{ id: 1, name: "Main" }];

    await call("cw_list_warehouses", { conditions: "inactiveFlag = false" });

    expect(client.gets()[0]).toMatchObject({
      path: "/procurement/warehouses",
      params: { conditions: "inactiveFlag = false", page: 1, pageSize: 25 },
    });
  });
});

describe("cw_list_warehouse_bins", () => {
  beforeEach(() => undefined);

  it("turns warehouseId into a conditions filter", async () => {
    const { client, call } = setup();
    await call("cw_list_warehouse_bins", { warehouseId: 3 });

    expect(client.gets()[0].params!.conditions).toBe("warehouse/id = 3");
  });

  it("combines warehouseId with caller conditions", async () => {
    const { client, call } = setup();
    await call("cw_list_warehouse_bins", {
      warehouseId: 3,
      conditions: "inactiveFlag = false",
    });

    expect(client.gets()[0].params!.conditions).toBe(
      "(inactiveFlag = false) and (warehouse/id = 3)",
    );
  });

  it("leaves conditions unset when neither is given", async () => {
    const { client, call } = setup();
    await call("cw_list_warehouse_bins", {});

    expect(client.gets()[0].params!.conditions).toBeUndefined();
  });
});

describe("cw_get_inventory_on_hand", () => {
  /** Two bins, a mix of positive, negative and zero balances. */
  function inventoryFixture(): GetResponder {
    const bins = [
      { id: 10, name: "BIN-A", warehouse: { id: 1, name: "Main" } },
      { id: 11, name: "BIN-B", warehouse: { id: 1, name: "Main" } },
    ];

    const onHand: Record<number, unknown[]> = {
      10: [
        {
          id: 100,
          catalogItem: { id: 500, identifier: "SW-1", name: "Switch" },
          warehouse: { id: 1, name: "Main" },
          warehouseBin: { id: 10, name: "BIN-A" },
          onHand: 7,
        },
        {
          // Zero balance: must be dropped.
          id: 101,
          catalogItem: { id: 501, identifier: "SW-2", name: "Switch 2" },
          warehouse: { id: 1, name: "Main" },
          warehouseBin: { id: 10, name: "BIN-A" },
          onHand: 0,
        },
      ],
      11: [
        {
          // Negative balance: must be kept.
          id: 102,
          catalogItem: { id: 502, identifier: "AP-1", name: "Access point" },
          warehouse: { id: 1, name: "Main" },
          warehouseBin: { id: 11, name: "BIN-B" },
          onHand: -2,
          serialNumbers: [{ id: 1, serialNumber: "SN-001" }, { id: 2, serialNumber: "SN-002" }],
        },
      ],
    };

    const catalog: Record<number, unknown> = {
      500: { id: 500, identifier: "SW-1", description: "24 port switch", cost: 100.5 },
      502: {
        id: 502,
        identifier: "AP-1",
        description: "Wireless AP",
        cost: 250,
        serializedFlag: true,
      },
    };

    return (path, params) => {
      if (path === "/procurement/warehouseBins") return bins;

      const binMatch = path.match(/^\/procurement\/warehouseBins\/(\d+)\/inventoryOnHand$/);
      if (binMatch) return onHand[Number(binMatch[1])] ?? [];

      if (path === "/procurement/catalog") {
        const ids = String(params.conditions ?? "")
          .replace(/^id in \(|\)$/g, "")
          .split(",")
          .map(Number);
        return ids.map((id) => catalog[id]).filter(Boolean);
      }

      return [];
    };
  }

  it("keeps non-zero rows including negatives and drops zeroes", async () => {
    const { client, call } = setup();
    client.getResponder = inventoryFixture();

    const result = await call("cw_get_inventory_on_hand", { warehouseId: 1 });

    expect(result.summary.rowCount).toBe(2);
    expect(result.summary.negativeRowCount).toBe(1);
    expect(result.rows.map((r: { identifier: string }) => r.identifier)).toEqual([
      "SW-1",
      "AP-1",
    ]);
    expect(result.rows.some((r: { onHand: number }) => r.onHand === 0)).toBe(false);
  });

  it("walks every bin returned", async () => {
    const { client, call } = setup();
    client.getResponder = inventoryFixture();

    await call("cw_get_inventory_on_hand", { warehouseId: 1 });

    const binPaths = client
      .gets()
      .map((c) => c.path)
      .filter((p) => p.includes("inventoryOnHand"));
    expect(binPaths).toEqual([
      "/procurement/warehouseBins/10/inventoryOnHand",
      "/procurement/warehouseBins/11/inventoryOnHand",
    ]);
  });

  it("reports item identity, bin, cost and extended value", async () => {
    const { client, call } = setup();
    client.getResponder = inventoryFixture();

    const result = await call("cw_get_inventory_on_hand", { warehouseId: 1 });

    expect(result.rows[0]).toMatchObject({
      catalogItemId: 500,
      identifier: "SW-1",
      description: "24 port switch",
      warehouseId: 1,
      warehouse: "Main",
      warehouseBinId: 10,
      warehouseBin: "BIN-A",
      onHand: 7,
      unitCost: 100.5,
      extendedValue: 703.5,
    });
  });

  it("carries a negative extended value on a negative balance", async () => {
    const { client, call } = setup();
    client.getResponder = inventoryFixture();

    const result = await call("cw_get_inventory_on_hand", { warehouseId: 1 });

    // -2 units at 250 each, plus 7 at 100.50.
    expect(result.rows[1].extendedValue).toBe(-500);
    expect(result.summary.totalExtendedValue).toBe(203.5);
    expect(result.summary.totalOnHandUnits).toBe(5);
  });

  it("surfaces serial numbers for serialised items", async () => {
    const { client, call } = setup();
    client.getResponder = inventoryFixture();

    const result = await call("cw_get_inventory_on_hand", { warehouseId: 1 });

    expect(result.rows[1]).toMatchObject({
      serialised: true,
      serialNumberCount: 2,
      serialNumbers: ["SN-001", "SN-002"],
    });
    // The non-serialised row carries no serialNumbers key at all.
    expect(result.rows[0].serialNumbers).toBeUndefined();
    expect(result.rows[0].serialNumberCount).toBe(0);
  });

  it("omits serial numbers when asked to", async () => {
    const { client, call } = setup();
    client.getResponder = inventoryFixture();

    const result = await call("cw_get_inventory_on_hand", {
      warehouseId: 1,
      includeSerialNumbers: false,
    });

    expect(result.rows[1].serialNumbers).toBeUndefined();
    // The count still reports, so a caller knows serials exist.
    expect(result.rows[1].serialNumberCount).toBe(2);
  });

  it("flags rows with no cost rather than silently valuing them at zero", async () => {
    const { client, call } = setup();
    // Item 502 is missing from the catalog lookup.
    client.getResponder = (path) => {
      if (path === "/procurement/warehouseBins") {
        return [{ id: 10, name: "BIN-A", warehouse: { id: 1, name: "Main" } }];
      }
      if (path.includes("inventoryOnHand")) {
        return [
          {
            catalogItem: { id: 999, identifier: "MYSTERY", name: "Unknown" },
            warehouse: { id: 1, name: "Main" },
            warehouseBin: { id: 10, name: "BIN-A" },
            onHand: 4,
          },
        ];
      }
      if (path === "/procurement/catalog") return [];
      return [];
    };

    const result = await call("cw_get_inventory_on_hand", { warehouseId: 1 });

    expect(result.rows[0].unitCost).toBeNull();
    expect(result.rows[0].extendedValue).toBeNull();
    expect(result.summary.rowsMissingCost).toBe(1);
    expect(result.summary.totalExtendedValue).toBe(0);
    // Identifier still falls back to the inventory reference.
    expect(result.rows[0].identifier).toBe("MYSTERY");
  });

  it("pages a bin fully rather than stopping at the first page", async () => {
    const { client, call } = setup();
    const page1 = Array.from({ length: 1000 }, () => ({
      catalogItem: { id: 1, identifier: "SKU", name: "Item" },
      warehouse: { id: 1, name: "Main" },
      warehouseBin: { id: 10, name: "BIN-A" },
      onHand: 1,
    }));
    const page2 = [
      {
        catalogItem: { id: 1, identifier: "SKU", name: "Item" },
        warehouse: { id: 1, name: "Main" },
        warehouseBin: { id: 10, name: "BIN-A" },
        onHand: 5,
      },
    ];

    client.getResponder = (path, params) => {
      if (path === "/procurement/warehouseBins") {
        return [{ id: 10, name: "BIN-A", warehouse: { id: 1, name: "Main" } }];
      }
      if (path.includes("inventoryOnHand")) {
        return params.page === 1 ? page1 : params.page === 2 ? page2 : [];
      }
      return [];
    };

    const result = await call("cw_get_inventory_on_hand", {
      warehouseId: 1,
      includeCosts: false,
    });

    expect(result.summary.rowCount).toBe(1001);
    expect(result.summary.totalOnHandUnits).toBe(1005);

    const pages = client
      .gets()
      .filter((c) => c.path.includes("inventoryOnHand"))
      .map((c) => c.params!.page);
    expect(pages).toEqual([1, 2]);
  });

  it("excludes inactive bins by default and includes them on request", async () => {
    const { client, call } = setup();
    client.getResponder = () => [];

    await call("cw_get_inventory_on_hand", { warehouseId: 1 });
    expect(client.gets()[0].params!.conditions).toBe(
      "(warehouse/id = 1) and (inactiveFlag = false)",
    );

    const second = setup();
    second.client.getResponder = () => [];
    await second.call("cw_get_inventory_on_hand", {
      warehouseId: 1,
      includeInactiveBins: true,
    });
    expect(second.client.gets()[0].params!.conditions).toBe("warehouse/id = 1");
  });

  it("scans only the bins named in binIds", async () => {
    const { client, call } = setup();
    client.getResponder = () => [];

    await call("cw_get_inventory_on_hand", { binIds: [10, 12], warehouseId: 99 });

    expect(client.gets()[0].params!.conditions).toBe("id in (10,12)");
  });

  it("filters to a single catalog item when asked", async () => {
    const { client, call } = setup();
    client.getResponder = (path) =>
      path === "/procurement/warehouseBins"
        ? [{ id: 10, name: "BIN-A", warehouse: { id: 1, name: "Main" } }]
        : [];

    await call("cw_get_inventory_on_hand", { warehouseId: 1, catalogItemId: 500 });

    const binCall = client.gets().find((c) => c.path.includes("inventoryOnHand"));
    expect(binCall!.params!.conditions).toBe("catalogItem/id = 500");
  });

  it("skips catalog lookups when costs are not requested", async () => {
    const { client, call } = setup();
    client.getResponder = inventoryFixture();

    const result = await call("cw_get_inventory_on_hand", {
      warehouseId: 1,
      includeCosts: false,
    });

    expect(client.gets().some((c) => c.path === "/procurement/catalog")).toBe(false);
    expect(result.rows[0].unitCost).toBeNull();
    expect(result.summary.valueBasis).toMatch(/not requested/i);
  });
});

describe("cw_list_adjustment_types", () => {
  it("reads the adjustment types endpoint", async () => {
    const { client, call } = setup();
    client.getResponder = () => [{ id: 4, identifier: "WRITEOFF", name: "Write Off" }];

    await call("cw_list_adjustment_types", {});

    expect(client.gets()[0]).toMatchObject({
      path: "/procurement/adjustments/types",
      params: { page: 1, pageSize: 25 },
    });
  });
});

describe("cw_create_adjustment", () => {
  it("posts the header with a type reference and returns the id", async () => {
    const { client, call } = setup();
    client.postResponse = { id: 77, identifier: "STOCKTAKE-2026", closedFlag: false };

    const result = await call("cw_create_adjustment", {
      identifier: "STOCKTAKE-2026",
      typeId: 4,
      reason: "Zero out stale on-hand",
      notes: "Agreed with Nathan on 22 September 2026.",
    });

    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/procurement/adjustments",
      body: {
        identifier: "STOCKTAKE-2026",
        type: { id: 4 },
        reason: "Zero out stale on-hand",
        notes: "Agreed with Nathan on 22 September 2026.",
      },
    });
    expect(result.id).toBe(77);
  });

  it("omits reason and notes when not supplied", async () => {
    const { client, call } = setup();

    await call("cw_create_adjustment", { identifier: "ADJ-1", typeId: 4 });

    expect(client.calls[0].body).toEqual({ identifier: "ADJ-1", type: { id: 4 } });
  });
});

describe("cw_add_adjustment_detail", () => {
  it("posts a signed negative quantity with both warehouse and bin", async () => {
    const { client, call } = setup();

    await call("cw_add_adjustment_detail", {
      adjustmentId: 77,
      catalogItemId: 500,
      warehouseId: 1,
      warehouseBinId: 10,
      quantityAdjusted: -7,
    });

    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/procurement/adjustments/77/details",
      body: {
        catalogItem: { id: 500 },
        warehouse: { id: 1 },
        warehouseBin: { id: 10 },
        quantityAdjusted: -7,
      },
    });
  });

  it("leaves unitCost off the body when omitted, so ConnectWise applies its own", async () => {
    const { client, call } = setup();

    await call("cw_add_adjustment_detail", {
      adjustmentId: 77,
      catalogItemId: 500,
      warehouseId: 1,
      warehouseBinId: 10,
      quantityAdjusted: -7,
    });

    expect(client.calls[0].body).not.toHaveProperty("unitCost");
  });

  it("passes unitCost and description when given", async () => {
    const { client, call } = setup();

    await call("cw_add_adjustment_detail", {
      adjustmentId: 77,
      catalogItemId: 500,
      warehouseId: 1,
      warehouseBinId: 10,
      quantityAdjusted: -7,
      unitCost: 100.5,
      description: "Stale stock write-off",
    });

    expect(client.calls[0].body).toMatchObject({
      unitCost: 100.5,
      description: "Stale stock write-off",
    });
  });

  it("joins serial numbers into the single serialNumber field", async () => {
    const { client, call } = setup();

    await call("cw_add_adjustment_detail", {
      adjustmentId: 77,
      catalogItemId: 502,
      warehouseId: 1,
      warehouseBinId: 11,
      quantityAdjusted: -2,
      serialNumbers: ["SN-001", "SN-002"],
    });

    expect(client.calls[0].body).toMatchObject({ serialNumber: "SN-001,SN-002" });
  });

  it("rejects a serial number list over the 1000 character field limit", async () => {
    const { client, call } = setup();
    const serials = Array.from({ length: 100 }, (_, i) => `SERIAL-NUMBER-${i}-PADDING`);

    await expect(
      call("cw_add_adjustment_detail", {
        adjustmentId: 77,
        catalogItemId: 502,
        warehouseId: 1,
        warehouseBinId: 11,
        quantityAdjusted: -100,
        serialNumbers: serials,
      }),
    ).rejects.toThrow(/1000 character limit/);

    // Nothing was sent.
    expect(client.calls).toHaveLength(0);
  });

  it("omits serialNumber for an empty array", async () => {
    const { client, call } = setup();

    await call("cw_add_adjustment_detail", {
      adjustmentId: 77,
      catalogItemId: 500,
      warehouseId: 1,
      warehouseBinId: 10,
      quantityAdjusted: -7,
      serialNumbers: [],
    });

    expect(client.calls[0].body).not.toHaveProperty("serialNumber");
  });
});

describe("cw_get_adjustment", () => {
  it("returns the header with every detail line", async () => {
    const { client, call } = setup();
    client.getResponder = (path) => {
      if (path === "/procurement/adjustments/77") {
        return { id: 77, identifier: "ADJ-1", closedFlag: false };
      }
      if (path === "/procurement/adjustments/77/details") {
        return [
          { id: 1, quantityAdjusted: -7, unitCost: 100.5 },
          { id: 2, quantityAdjusted: -2, unitCost: 250 },
        ];
      }
      return [];
    };

    const result = await call("cw_get_adjustment", { id: 77 });

    expect(result.adjustment).toMatchObject({ id: 77, closedFlag: false });
    expect(result.detailCount).toBe(2);
    expect(result.details).toHaveLength(2);
  });

  it("pages the detail lines fully", async () => {
    const { client, call } = setup();
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1 }));

    client.getResponder = (path, params) => {
      if (path === "/procurement/adjustments/77") return { id: 77 };
      if (path === "/procurement/adjustments/77/details") {
        return params.page === 1 ? full : params.page === 2 ? [{ id: 1001 }] : [];
      }
      return [];
    };

    const result = await call("cw_get_adjustment", { id: 77 });

    expect(result.detailCount).toBe(1001);
  });
});

describe("cw_close_adjustment", () => {
  it("patches closedFlag to true", async () => {
    const { client, call } = setup();

    await call("cw_close_adjustment", { id: 77 });

    expect(client.calls[0]).toEqual({
      method: "PATCH",
      path: "/procurement/adjustments/77",
      body: [{ op: "replace", path: "closedFlag", value: true }],
    });
  });
});
