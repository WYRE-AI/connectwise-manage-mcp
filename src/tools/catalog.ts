import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { customFieldConditionsSchema } from "./custom-field-conditions.js";
import { READ_ONLY, ADDITIVE_WRITE, DESTRUCTIVE_WRITE } from "./annotations.js";

/**
 * Product Catalog tools (ConnectWise Procurement API).
 *
 * Covers the Product Catalog itself (/procurement/catalog) plus the lookup
 * entities typically needed when creating or filtering catalog items:
 * categories, subcategories, and manufacturers.
 */
export function registerCatalogTools(server: McpServer, client: CwManageClient) {
  // -------------------------------------------------------------------------
  // Catalog items
  // -------------------------------------------------------------------------

  server.tool(
    "cw_search_catalog_items",
    "Search the ConnectWise product catalog. Use 'conditions' for CW query syntax (e.g. \"identifier like '%SKU-%'\" or \"manufacturer/id=5\"). Filter on custom fields with 'customFieldConditions' (e.g. caption=\"Contract Type\" AND value=\"Managed\").",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      customFieldConditions: customFieldConditionsSchema,
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'identifier asc')"),
    },
    READ_ONLY,
    async ({ conditions, customFieldConditions, page, pageSize, orderBy }) => {
      const result = await client.get("/procurement/catalog", {
        conditions,
        customFieldConditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_catalog_item",
    "Get a specific catalog item by ID.",
    {
      id: z.number().describe("Catalog item ID"),
    },
    READ_ONLY,
    async ({ id }) => {
      const result = await client.get(`/procurement/catalog/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_create_catalog_item",
    "Create a new catalog item (product SKU) in ConnectWise. Surfaces the common MSP fields directly; use 'extraFields' for anything else supported by POST /procurement/catalog (e.g. manufacturerPartNumber, unitOfMeasure, ianCode, upc, minStockLevel).",
    {
      identifier: z.string().describe("Unique catalog item identifier / SKU"),
      description: z.string().describe("Product description"),
      subcategoryId: z.number().describe("Catalog subcategory ID (required by CW)"),
      typeId: z.number().describe("Product type ID (required by CW)"),
      cost: z.number().optional().describe("Cost to you"),
      price: z.number().optional().describe("Sale price"),
      categoryId: z.number().optional().describe("Catalog category ID"),
      manufacturerId: z.number().optional().describe("Manufacturer ID"),
      productClass: z
        .enum(["NonInventory", "Inventory", "Bundle", "Service", "Agreement"])
        .optional()
        .describe("Product class"),
      taxableFlag: z.boolean().optional().describe("Whether the item is taxable"),
      customerDescription: z.string().optional().describe("Customer-facing description"),
      extraFields: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Passthrough for any additional catalog item fields supported by the CW API (merged into the request body).",
        ),
    },
    ADDITIVE_WRITE,
    async ({
      identifier,
      description,
      subcategoryId,
      typeId,
      cost,
      price,
      categoryId,
      manufacturerId,
      productClass,
      taxableFlag,
      customerDescription,
      extraFields,
    }) => {
      const body: Record<string, unknown> = {
        identifier,
        description,
        subcategory: { id: subcategoryId },
        type: { id: typeId },
      };
      if (cost !== undefined) body.cost = cost;
      if (price !== undefined) body.price = price;
      if (categoryId !== undefined) body.category = { id: categoryId };
      if (manufacturerId !== undefined) body.manufacturer = { id: manufacturerId };
      if (productClass) body.productClass = productClass;
      if (taxableFlag !== undefined) body.taxableFlag = taxableFlag;
      if (customerDescription) body.customerDescription = customerDescription;
      if (extraFields) Object.assign(body, extraFields);

      const result = await client.post("/procurement/catalog", body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_update_catalog_item",
    "Update an existing catalog item using JSON Patch operations.",
    {
      id: z.number().describe("Catalog item ID"),
      operations: z
        .array(
          z.object({
            op: z.enum(["replace", "add", "remove"]).describe("Patch operation"),
            path: z.string().describe("JSON path (e.g. 'price', 'cost', 'description')"),
            value: z.unknown().optional().describe("New value"),
          }),
        )
        .describe("Array of JSON Patch operations"),
    },
    DESTRUCTIVE_WRITE,
    async ({ id, operations }) => {
      const result = await client.patch(`/procurement/catalog/${id}`, operations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // -------------------------------------------------------------------------
  // Supporting lookup entities
  // -------------------------------------------------------------------------

  server.tool(
    "cw_list_catalog_categories",
    "List product categories from the ConnectWise catalog.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25)"),
    },
    READ_ONLY,
    async ({ conditions, page, pageSize }) => {
      const result = await client.get("/procurement/categories", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_list_catalog_subcategories",
    "List product subcategories from the ConnectWise catalog.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string (e.g. \"category/id=3\")"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25)"),
    },
    READ_ONLY,
    async ({ conditions, page, pageSize }) => {
      const result = await client.get("/procurement/subCategories", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_list_manufacturers",
    "List manufacturers referenced by catalog items.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25)"),
    },
    READ_ONLY,
    async ({ conditions, page, pageSize }) => {
      const result = await client.get("/procurement/manufacturers", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
