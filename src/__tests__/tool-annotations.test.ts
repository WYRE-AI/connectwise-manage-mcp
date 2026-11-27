/**
 * Every registered ConnectWise tool must advertise an explicit readOnlyHint.
 * Without it, clients such as Claude treat the tool as a possible write
 * (ITCSNY / connectwise-manage-mcp v1.18.1).
 */

import { describe, it, expect } from "vitest";
import worker from "../worker.js";
import {
  READ_ONLY,
  ADDITIVE_WRITE,
  DESTRUCTIVE_WRITE,
} from "../tools/annotations.js";

/** Conduit `connectwise-psa` read tier (VENDOR_TOOL_CONFIG isWrite:false). */
const READ_TOOLS = new Set([
  "cw_get_activity",
  "cw_get_adjustment",
  "cw_get_agreement",
  "cw_get_agreement_additions",
  "cw_get_agreement_recap",
  "cw_get_catalog_item",
  "cw_get_catalog_item_inventory",
  "cw_get_company",
  "cw_get_configuration",
  "cw_get_contact",
  "cw_get_inventory_on_hand",
  "cw_get_invoice",
  "cw_get_member",
  "cw_get_opportunity",
  "cw_get_procurement_product",
  "cw_get_project",
  "cw_get_project_product_status",
  "cw_get_project_purchase_order_lines",
  "cw_get_project_ticket",
  "cw_get_project_ticket_notes",
  "cw_get_purchase_order",
  "cw_get_purchase_order_items",
  "cw_get_sales_order",
  "cw_get_sales_order_products",
  "cw_get_ticket",
  "cw_get_ticket_configurations",
  "cw_get_ticket_notes",
  "cw_get_time_entry",
  "cw_list_adjustment_types",
  "cw_list_boards",
  "cw_list_catalog_categories",
  "cw_list_catalog_subcategories",
  "cw_list_communication_types",
  "cw_list_company_sites",
  "cw_list_manufacturers",
  "cw_list_priorities",
  "cw_list_schedule_statuses",
  "cw_list_schedule_types",
  "cw_list_statuses",
  "cw_list_warehouse_bins",
  "cw_list_warehouses",
  "cw_search_activities",
  "cw_search_agreement_recaps",
  "cw_search_agreements",
  "cw_search_catalog_items",
  "cw_search_companies",
  "cw_search_configurations",
  "cw_search_contacts",
  "cw_search_invoices",
  "cw_search_members",
  "cw_search_opportunities",
  "cw_search_opportunity_forecasts",
  "cw_search_opportunity_notes",
  "cw_search_procurement_products",
  "cw_search_project_tickets",
  "cw_search_projects",
  "cw_search_purchase_orders",
  "cw_search_sales_orders",
  "cw_search_sales_stages",
  "cw_search_schedule_entries",
  "cw_search_tickets",
  "cw_search_time_entries",
  "cw_test_connection",
]);

/** Creates / additive posts (destructiveHint:false). */
const ADDITIVE_WRITE_TOOLS = new Set([
  "cw_add_adjustment_detail",
  "cw_add_project_ticket_note",
  "cw_add_ticket_note",
  "cw_create_activity",
  "cw_create_adjustment",
  "cw_create_agreement_addition",
  "cw_create_catalog_item",
  "cw_create_company",
  "cw_create_contact",
  "cw_create_project",
  "cw_create_schedule_entry",
  "cw_create_ticket",
]);

/** Deletes, patches, moves, irreversible posts (destructiveHint:true). */
const DESTRUCTIVE_WRITE_TOOLS = new Set([
  "cw_bundle_tickets",
  "cw_close_adjustment",
  "cw_create_time_entry",
  "cw_delete_time_entry",
  "cw_update_agreement_addition",
  "cw_update_catalog_item",
  "cw_update_company",
  "cw_update_contact",
  "cw_update_contact_types",
  "cw_update_invoice",
  "cw_update_schedule_entry",
  "cw_update_ticket",
  "cw_update_ticket_configurations",
  "cw_update_time_entry",
]);

type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type ListedTool = { name: string; annotations?: ToolAnnotations };

async function listTools(): Promise<ListedTool[]> {
  const response = await worker.fetch(
    new Request("http://worker.local/mcp", {
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
    }),
    { AUTH_MODE: "gateway" },
  );
  const body = (await response.json()) as { result: { tools: ListedTool[] } };
  return body.result.tools;
}

describe("MCP tool annotations", () => {
  it("advertises an explicit readOnlyHint on every registered tool", async () => {
    const tools = await listTools();
    expect(tools.length).toBe(89);

    const missing = tools.filter((tool) => typeof tool.annotations?.readOnlyHint !== "boolean");
    expect(missing.map((tool) => tool.name)).toEqual([]);

    const read: string[] = [];
    const write: string[] = [];
    const destructive: string[] = [];

    for (const tool of tools) {
      const ann = tool.annotations!;
      if (ann.readOnlyHint === true) {
        read.push(tool.name);
        expect(ann, tool.name).toMatchObject(READ_ONLY);
        expect(READ_TOOLS.has(tool.name), `${tool.name} should be a known read tool`).toBe(true);
      } else {
        write.push(tool.name);
        expect(ann.readOnlyHint, tool.name).toBe(false);
        if (ann.destructiveHint === true) {
          destructive.push(tool.name);
          expect(ann, tool.name).toMatchObject(DESTRUCTIVE_WRITE);
          expect(DESTRUCTIVE_WRITE_TOOLS.has(tool.name), `${tool.name} should be destructive`).toBe(
            true,
          );
        } else {
          expect(ann, tool.name).toMatchObject(ADDITIVE_WRITE);
          expect(ADDITIVE_WRITE_TOOLS.has(tool.name), `${tool.name} should be additive`).toBe(true);
        }
      }
    }

    expect(read.sort()).toEqual([...READ_TOOLS].sort());
    expect(write.sort()).toEqual(
      [...ADDITIVE_WRITE_TOOLS, ...DESTRUCTIVE_WRITE_TOOLS].sort(),
    );
    expect(destructive.sort()).toEqual([...DESTRUCTIVE_WRITE_TOOLS].sort());

    // Final counts for the release notes: 63 read / 26 write (12 additive + 14
    // destructive). Conduit tiers are 63 read / 25 write / 1 admin; the admin
    // tool (cw_close_adjustment) is a destructive write at the MCP layer.
    // cw_create_time_entry is destructive because it may PATCH ticket flags.
    expect({
      read: read.length,
      write: write.length,
      destructive: destructive.length,
      additive: write.length - destructive.length,
    }).toEqual({ read: 63, write: 26, destructive: 14, additive: 12 });
  });
});
