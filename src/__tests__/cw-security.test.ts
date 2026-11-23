import { afterEach, describe, expect, it, vi } from "vitest";
import { CwApiError, CwManageClient } from "../api-client.js";
import { isPermissionRefusal, securityHint, securityRequirementFor } from "../cw-security.js";

describe("securityRequirementFor", () => {
  it.each([
    ["/procurement/warehouseBins", "System", /Table Setup.*Warehouse Bin/],
    ["/procurement/warehouseBins/10/inventoryOnHand", "System", /Table Setup.*Warehouse Bin/],
    ["/procurement/warehouses", "System", /Table Setup.*Inventory \/ Warehouse/],
    ["/procurement/adjustments/types", "System", /Adjustment Type/],
    ["/procurement/adjustments", "Procurement", /Inventory Adjustments/],
    ["/procurement/adjustments/4/details", "Procurement", /Inventory Adjustments/],
    ["/procurement/catalog/500/inventory", "Procurement", /Product Catalog/],
    ["/procurement/catalog", "Procurement", /Product Catalog/],
    ["/procurement/products", "Procurement", /^Products/],
    ["/procurement/products/9/pickingShippingDetails", "Procurement", /^Products/],
    ["/procurement/purchaseorders/7/lineitems", "Procurement", /Purchase Orders/],
    ["/project/projects", "Project", /Project Headers/],
  ])("%s needs %s > %s", (path, module, permission) => {
    const req = securityRequirementFor(path);
    expect(req?.module).toBe(module);
    expect(req?.permission).toMatch(permission);
  });

  it("ignores a query string", () => {
    expect(securityRequirementFor("/procurement/products?conditions=x")?.permission).toMatch(/^Products/);
  });

  it("returns undefined for an unknown path", () => {
    expect(securityRequirementFor("/system/unknownThing")).toBeUndefined();
    expect(securityHint("/system/unknownThing")).toMatch(/System > Security Roles/);
  });

  it("points a bin refusal at the catalog inventory tool", () => {
    expect(securityHint("/procurement/warehouseBins")).toMatch(/cw_get_catalog_item_inventory/);
  });
});

describe("isPermissionRefusal", () => {
  it("treats every 403 as a refusal", () => {
    expect(isPermissionRefusal(403, undefined)).toBe(true);
  });
  it("treats a 401 or 400 that talks about permission as a refusal", () => {
    expect(isPermissionRefusal(401, "You do not have security permission to access this")).toBe(true);
    expect(isPermissionRefusal(400, "no security permission")).toBe(true);
  });
  it("leaves ordinary validation errors alone", () => {
    expect(isPermissionRefusal(400, "conditions: unknown field")).toBe(false);
    expect(isPermissionRefusal(500, "permission")).toBe(false);
  });
});

describe("CwApiError message", () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () =>
    new CwManageClient({
      baseUrl: "https://cw.example.test",
      companyId: "acme",
      publicKey: "pub",
      privateKey: "priv",
      clientId: "cid",
    });

  it("names Table Setup when the warehouse bin list is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: "Forbidden", message: "no security permission" }), { status: 403 }),
      ),
    );
    const err = (await client().get("/procurement/warehouseBins").catch((e: unknown) => e)) as CwApiError;
    expect(err).toBeInstanceOf(CwApiError);
    expect(err.message).toMatch(/System > Table Setup/);
    expect(err.message).toMatch(/Inventory \/ Warehouse Bin/);
  });

  it("names Procurement > Products when the product list is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));
    const err = (await client().get("/procurement/products").catch((e: unknown) => e)) as CwApiError;
    expect(err.message).toMatch(/Procurement > Products \(Inquire\)/);
  });

  it("adds no hint to a plain 400", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "bad conditions" }), { status: 400 })),
    );
    const err = (await client().get("/procurement/products").catch((e: unknown) => e)) as CwApiError;
    expect(err.message).not.toMatch(/security role/);
  });
});
