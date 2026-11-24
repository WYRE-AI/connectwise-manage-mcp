/**
 * Which ConnectWise Manage security role permission an API path needs.
 *
 * ConnectWise answers a request the API member's security role does not
 * allow with HTTP 403 and a terse "no security permission" style message
 * that never says which permission is missing. That leaves a caller guessing,
 * and it is especially confusing for setup-table lookups: warehouses,
 * warehouse bins and adjustment types are not covered by the Procurement
 * permissions at all, but by System > Table Setup.
 *
 * `securityRequirementFor` maps an API path to the module and permission an
 * administrator grants under System > Security Roles. The table covers the
 * paths this server calls; anything else falls back to a generic hint.
 *
 * Mapping sources: the ConnectWise PSA security role screen (module and
 * permission names as shown there) and the Table Setup list ConnectWise
 * integrations document for procurement (Inventory / Warehouse, Inventory /
 * Warehouse Bin, Inventory / Adjustment Type, Inventory / Purchase Order
 * Status).
 *
 * This module has no imports and is side-effect free.
 */

/** A security role permission, as named on the ConnectWise Security Roles screen. */
export interface SecurityRequirement {
  /** Module heading on the security role screen, e.g. "Procurement". */
  module: string;
  /** Permission row under that module, e.g. "Product Catalog". */
  permission: string;
  /** Optional extra guidance, e.g. a tool that avoids the permission. */
  note?: string;
}

interface Rule {
  pattern: RegExp;
  requirement: SecurityRequirement;
}

const TABLE_SETUP = (table: string, note?: string): SecurityRequirement => ({
  module: "System",
  permission: `Table Setup (Inquire), with the ${table} setup table allowed`,
  ...(note ? { note } : {}),
});

const BIN_NOTE =
  "Warehouses and bins are setup tables, not Procurement records, so Procurement > Inventory Adjustments, Inventory Transfers or Product Catalog access does not cover them. To read stock for one item without Table Setup, use cw_get_catalog_item_inventory (needs only Procurement > Product Catalog).";

// Most specific first: the first match wins.
const RULES: Rule[] = [
  // Procurement: stock
  {
    pattern: /^\/procurement\/catalog\/[^/]+\/(inventory|quantityOnHand|minimumStockByWarehouse)\b/i,
    requirement: { module: "Procurement", permission: "Product Catalog (Inquire)" },
  },
  {
    pattern: /^\/procurement\/warehouseBins\/[^/]+\/inventoryOnHand\b/i,
    requirement: TABLE_SETUP("Inventory / Warehouse Bin", BIN_NOTE),
  },
  { pattern: /^\/procurement\/warehouseBins\b/i, requirement: TABLE_SETUP("Inventory / Warehouse Bin", BIN_NOTE) },
  { pattern: /^\/procurement\/warehouses\b/i, requirement: TABLE_SETUP("Inventory / Warehouse", BIN_NOTE) },
  { pattern: /^\/procurement\/onhandserialnumbers\b/i, requirement: { module: "Procurement", permission: "Serial Number Search (Inquire)" } },
  // Procurement: setup tables
  { pattern: /^\/procurement\/adjustments\/types\b/i, requirement: TABLE_SETUP("Inventory / Adjustment Type") },
  { pattern: /^\/procurement\/purchaseorderstatuses\b/i, requirement: TABLE_SETUP("Inventory / Purchase Order Status") },
  { pattern: /^\/procurement\/(categories|subCategories)\b/i, requirement: TABLE_SETUP("product category and subcategory") },
  { pattern: /^\/procurement\/manufacturers\b/i, requirement: TABLE_SETUP("manufacturer") },
  // Procurement: records
  { pattern: /^\/procurement\/adjustments\b/i, requirement: { module: "Procurement", permission: "Inventory Adjustments" } },
  { pattern: /^\/procurement\/transfers\b/i, requirement: { module: "Procurement", permission: "Inventory Transfers" } },
  { pattern: /^\/procurement\/catalog\b/i, requirement: { module: "Procurement", permission: "Product Catalog" } },
  {
    pattern: /^\/procurement\/products\b/i,
    requirement: {
      module: "Procurement",
      permission: "Products (Inquire)",
      note: "Products is a separate permission from Product Catalog: the catalog holds SKU definitions, Products holds the items placed on tickets, projects and orders.",
    },
  },
  { pattern: /^\/procurement\/purchaseorders\b/i, requirement: { module: "Procurement", permission: "Purchase Orders (Inquire)" } },
  // Other modules this server calls
  { pattern: /^\/sales\/activities\b/i, requirement: { module: "Companies", permission: "CRM / Sales Activities" } },
  { pattern: /^\/project\/projects\b/i, requirement: { module: "Project", permission: "Project Headers" } },
  { pattern: /^\/project\/tickets\b/i, requirement: { module: "Project", permission: "Project Tickets" } },
  { pattern: /^\/service\/tickets\b/i, requirement: { module: "Service Desk", permission: "Service Tickets" } },
  { pattern: /^\/finance\/agreements\b/i, requirement: { module: "Finance", permission: "Agreements" } },
  { pattern: /^\/company\/configurations\b/i, requirement: { module: "Companies", permission: "Configurations" } },
  { pattern: /^\/company\/contacts\b/i, requirement: { module: "Companies", permission: "Contacts" } },
  { pattern: /^\/company\/companies\b/i, requirement: { module: "Companies", permission: "Company Maintenance" } },
  { pattern: /^\/time\/entries\b/i, requirement: { module: "Time & Expense", permission: "Time Entry" } },
];

/** The security role permission an API path needs, or undefined when this server does not know it. */
export function securityRequirementFor(path: string): SecurityRequirement | undefined {
  const bare = path.split("?")[0];
  return RULES.find((rule) => rule.pattern.test(bare))?.requirement;
}

const PERMISSION_WORDS = /secur\w*\s+permission|not\s+authori[sz]ed|permission/i;

/**
 * True when a failed response is a security-role refusal. ConnectWise sends
 * 403 for these; some builds send 401 or 400 with a "security permission"
 * message, so a permission-worded message counts too.
 */
export function isPermissionRefusal(status: number, message: string | undefined): boolean {
  if (status === 403) return true;
  if (status >= 400 && status < 500 && typeof message === "string") {
    return PERMISSION_WORDS.test(message);
  }
  return false;
}

/** One sentence naming the permission to grant, for appending to an error message. */
export function securityHint(path: string): string {
  const req = securityRequirementFor(path);
  if (!req) {
    return "ConnectWise refused this for lack of a security role permission. Check the API member's security role (System > Security Roles) for the module that owns this endpoint.";
  }
  const base = `ConnectWise refused this for lack of a security role permission: grant the API member's security role ${req.module} > ${req.permission} (System > Security Roles).`;
  return req.note ? `${base} ${req.note}` : base;
}
