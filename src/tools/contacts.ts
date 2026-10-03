import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { buildContactSearchQuery } from "./contact-search.js";
import {
  asContactList,
  assertContactPatchOperations,
  assertContactTypeUpdateArgs,
  contactTypeNameCondition,
  findTypeAssociations,
  pickContactType,
  type ContactTypeAssociation,
  type ContactTypeRecord,
} from "./contact-type-update.js";

// Same rule as cw_update_agreement_addition: z.unknown() accepts a missing
// key (Zod treats it as undefined), so add/replace must explicitly require
// a value. RFC 6902 forbids a patch that omits it. Remove may omit value.
const requiredPatchValue = z.unknown().refine((value) => value !== undefined, {
  message: "value is required for add/replace operations (RFC 6902)",
});

const contactPatchOperation = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    path: z
      .string()
      .describe(
        "Field path (e.g. 'firstName', 'title', 'inactiveFlag', 'site', 'communicationItems', 'customFields')",
      ),
    value: requiredPatchValue.describe("New value"),
  }),
  z.object({
    op: z.literal("replace"),
    path: z
      .string()
      .describe(
        "Field path (e.g. 'firstName', 'title', 'inactiveFlag', 'site', 'communicationItems', 'customFields')",
      ),
    value: requiredPatchValue.describe("New value"),
  }),
  z.object({
    op: z.literal("remove"),
    path: z.string().describe("Field path (e.g. 'title', 'site')"),
    value: z.unknown().optional().describe("Unused for remove"),
  }),
]);

export function registerContactTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_contacts",
    "Search contacts in ConnectWise Manage. Parent fields go in conditions with double-quoted strings (e.g. firstName = \"John\" or company/id = 5). There is no contact field named name — use firstName and lastName (a bare name = \"...\" is rewritten to those). Contact type is a child collection: do not put types or types/name in conditions (Manage returns 400 ApiFindCondition). Filter type with typeName, typeId, or childConditions such as types/name = \"Primary\". Single quotes are accepted and sent as double quotes.",
    {
      conditions: z
        .string()
        .optional()
        .describe("Parent-field conditions. Strings use double quotes. types/name is not valid here — use typeName or childConditions."),
      childConditions: z
        .string()
        .optional()
        .describe("Child-collection conditions, e.g. types/name = \"Primary\" or types/id = 2. This is the Manage query param that filters contact type without listing every contact."),
      typeName: z
        .string()
        .optional()
        .describe("Contact type name. Sent as childConditions types/name=\"...\". Prefer this over conditions types/name."),
      typeId: z
        .number()
        .optional()
        .describe("Contact type id. Sent as childConditions types/id=<id>."),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by"),
    },
    async ({ conditions, childConditions, typeName, typeId, page, pageSize, orderBy }) => {
      const query = buildContactSearchQuery({ conditions, childConditions, typeName, typeId });
      const result = await client.get("/company/contacts", {
        conditions: query.conditions,
        childConditions: query.childConditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_contact",
    "Get a specific contact by ID.",
    {
      id: z.number().describe("Contact ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/company/contacts/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_create_contact",
    "Create a new contact.",
    {
      firstName: z.string().describe("First name"),
      lastName: z.string().describe("Last name"),
      companyId: z.number().describe("Company ID to associate the contact with"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      title: z.string().optional().describe("Job title"),
    },
    async ({ firstName, lastName, companyId, email, phone, title }) => {
      const body: Record<string, unknown> = {
        firstName,
        lastName,
        company: { id: companyId },
      };
      if (title) body.title = title;

      // CW Manage uses communicationItems for email/phone
      const comms: Array<Record<string, unknown>> = [];
      if (email) {
        comms.push({ type: { name: "Email" }, value: email, communicationType: "Email" });
      }
      if (phone) {
        comms.push({ type: { name: "Direct" }, value: phone, communicationType: "Phone" });
      }
      if (comms.length) body.communicationItems = comms;

      const result = await client.post("/company/contacts", body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_update_contact",
    "Update an existing contact with JSON Patch (Manage PATCH /company/contacts/{id}). Operations use the same shape as cw_update_ticket and cw_update_company: op (replace, add, or remove), path, and value. Add and replace require value. Common paths: firstName, lastName, title, inactiveFlag, site (value is { \"id\": <siteId> }), communicationItems (email and phone — replacing the array replaces every item, so include items to keep; each item is { \"type\": { \"name\": \"Email\" }, \"value\": \"...\", \"communicationType\": \"Email\" } or communicationType \"Phone\"), and customFields (array of { \"id\", \"value\" }). Contact types such as \"Decision Maker\" are a child collection. Manage accepts typeIds only when creating a contact and rejects types on this patch. Use cw_update_contact_types to add or remove a type.",
    {
      id: z.number().describe("Contact ID"),
      operations: z
        .array(contactPatchOperation)
        .describe("Array of JSON Patch operations"),
    },
    async ({ id, operations }) => {
      assertContactPatchOperations(operations);
      const result = await client.patch(`/company/contacts/${id}`, operations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_update_contact_types",
    "Add or remove a contact type association (Manage POST or DELETE /company/contacts/{id}/typeAssociations). Use this instead of cw_update_contact when tagging a contact, for example as Decision Maker after they authorize someone in a ticket note. action \"add\" takes typeName or typeId. typeName is resolved with GET /company/contacts/types. Adding a type the contact already has returns the existing association and does not create a duplicate. action \"remove\" takes associationId, or typeName / typeId to find the association and delete it.",
    {
      id: z.number().describe("Contact ID"),
      action: z.enum(["add", "remove"]).describe("add tags the contact with the type; remove untags it"),
      typeName: z
        .string()
        .optional()
        .describe('Contact type name, e.g. "Decision Maker". Resolved against GET /company/contacts/types.'),
      typeId: z
        .number()
        .optional()
        .describe("Contact type id from /company/contacts/types. Used instead of typeName when both are set."),
      associationId: z
        .number()
        .optional()
        .describe("Type-association id to remove. Only used with action remove; skips the type lookup."),
    },
    async ({ id, action, typeName, typeId, associationId }) => {
      const result = await updateContactTypes(client, { id, action, typeName, typeId, associationId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}

async function updateContactTypes(
  client: CwManageClient,
  input: {
    id: number;
    action: "add" | "remove";
    typeName?: string;
    typeId?: number;
    associationId?: number;
  },
): Promise<Record<string, unknown>> {
  assertContactTypeUpdateArgs(input);
  const { id, action } = input;
  const typeName = input.typeName?.trim() || undefined;

  if (action === "remove" && input.associationId !== undefined) {
    await client.delete(`/company/contacts/${id}/typeAssociations/${input.associationId}`);
    return {
      action: "remove",
      removed: true,
      contactId: id,
      associationIds: [input.associationId],
    };
  }

  let resolvedTypeId = input.typeId;
  let resolvedTypeName = typeName;
  if (resolvedTypeId === undefined && resolvedTypeName) {
    const listed = await client.get<unknown>("/company/contacts/types", {
      conditions: contactTypeNameCondition(resolvedTypeName),
      pageSize: 50,
    });
    const picked = pickContactType(asContactList<ContactTypeRecord>(listed, "contact type"), resolvedTypeName);
    resolvedTypeId = picked.id;
    resolvedTypeName = picked.name;
  }

  const listedAssociations = await client.get<unknown>(`/company/contacts/${id}/typeAssociations`, {
    pageSize: 1000,
  });
  const matches = findTypeAssociations(
    asContactList<ContactTypeAssociation>(listedAssociations, "contact type association"),
    { typeId: resolvedTypeId, typeName: resolvedTypeId === undefined ? resolvedTypeName : undefined },
  );

  if (action === "add") {
    if (resolvedTypeId === undefined) {
      throw new Error(
        'cw_update_contact_types action "add" requires typeId or typeName (for example "Decision Maker").',
      );
    }
    if (matches.length > 0) {
      return {
        action: "add",
        alreadyAssigned: true,
        contactId: id,
        association: matches[0],
      };
    }
    const association = await client.post(`/company/contacts/${id}/typeAssociations`, {
      type: { id: resolvedTypeId },
      contact: { id },
    });
    return { action: "add", alreadyAssigned: false, contactId: id, association };
  }

  if (matches.length === 0) {
    const label = resolvedTypeName ? `"${resolvedTypeName}"` : `id ${resolvedTypeId}`;
    throw new Error(`Contact ${id} is not assigned contact type ${label}.`);
  }

  const associationIds: number[] = [];
  for (const match of matches) {
    if (match.id === undefined) continue;
    await client.delete(`/company/contacts/${id}/typeAssociations/${match.id}`);
    associationIds.push(match.id);
  }
  if (associationIds.length === 0) {
    throw new Error(
      `Contact ${id} has a matching type association without an id. Pass associationId to remove it.`,
    );
  }
  return { action: "remove", removed: true, contactId: id, associationIds };
}
