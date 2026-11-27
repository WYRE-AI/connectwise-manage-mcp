import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient, hasApiStatus } from "../api-client.js";
import { customFieldConditionsSchema } from "./custom-field-conditions.js";
import { buildTicketCard, TICKET_CARD_META } from "../card.builder.js";
import { buildTicketNoteBody, mapCreatedNoteResponse } from "./note-payload.js";
import { READ_ONLY, ADDITIVE_WRITE, DESTRUCTIVE_WRITE } from "./annotations.js";

export function registerTicketTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_get_ticket_configurations",
    "Get configuration references associated with a service ticket, one page at a time (default: page 1, 25 results). Request additional pages as needed. Returns id, deviceIdentifier, and _info when provided by Manage; use cw_get_configuration for full configuration details.",
    {
      id: z.number().int().positive().describe("Service ticket ID"),
      page: z.number().int().positive().optional().describe("Page number (default: 1)"),
      pageSize: z.number().int().positive().max(1000).optional().describe("Results per page (default: 25, max: 1000)"),
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'id asc')"),
    },
    READ_ONLY,
    async ({ id, page, pageSize, conditions, orderBy }) => {
      const result = await client.get(`/service/tickets/${id}/configurations`, {
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        conditions,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_update_ticket_configurations",
    "Add or remove configuration associations on a service ticket. Operations run sequentially in the supplied order, including repeated configuration IDs. Removing an association leaves the configuration object intact. Continues after individual failures without rollback or automatic retries; returns every operation's outcome and sets isError if any fail. Duplicate-add and missing-association errors are reported as failures.",
    {
      id: z.number().int().positive().describe("Service ticket ID"),
      operations: z.array(z.object({
        action: z.enum(["add", "remove"]).describe("Add or remove the ticket association"),
        configurationId: z.number().int().positive().describe("Existing configuration object ID"),
      })).min(1).describe("Nonempty ordered list of configuration association changes"),
    },
    DESTRUCTIVE_WRITE,
    async ({ id, operations }) => {
      const results = [];
      const path = `/service/tickets/${id}/configurations`;
      for (const operation of operations) {
        try {
          if (operation.action === "add") {
            const configuration = await client.post(path, { id: operation.configurationId });
            results.push({ ...operation, success: true, configuration });
          } else {
            await client.delete(`${path}/${operation.configurationId}`);
            results.push({ ...operation, success: true });
          }
        } catch (err: unknown) {
          results.push({
            ...operation,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const success = results.every((result) => result.success);
      return {
        content: [{ type: "text", text: JSON.stringify({ ticketId: id, success, results }, null, 2) }],
        isError: !success,
      };
    },
  );

  server.tool(
    "cw_search_tickets",
    "Search service tickets in ConnectWise Manage. Use 'conditions' for CW query syntax (e.g. \"status/name != 'Closed'\" or \"company/name = 'Acme'\"). Filter on custom fields with 'customFieldConditions' (e.g. caption=\"Contract Type\" AND value=\"Managed\").",
    {
      conditions: z
        .string()
        .optional()
        .describe("ConnectWise conditions query string"),
      customFieldConditions: customFieldConditionsSchema,
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z
        .number()
        .optional()
        .describe("Results per page (default: 25, max: 1000)"),
      orderBy: z
        .string()
        .optional()
        .describe("Field to order by (e.g. 'id desc')"),
    },
    READ_ONLY,
    async ({ conditions, customFieldConditions, page, pageSize, orderBy }) => {
      const result = await client.get("/service/tickets", {
        conditions,
        customFieldConditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "cw_get_ticket",
    {
      annotations: READ_ONLY,
      description: "Get a specific service ticket by ID.",
      inputSchema: {
        id: z.number().describe("Ticket ID"),
      },
      // MCP Apps (SEP-1865): renders as an interactive ticket card in App hosts.
      _meta: TICKET_CARD_META,
    },
    async ({ id }) => {
      const result = await client.get<Record<string, unknown>>(`/service/tickets/${id}`);
      // MCP Apps: attach the normalized card payload the ui:// ticket card
      // renders from. Best-effort — a null card just means no UI surface.
      const card = await buildTicketCard(result, client);
      const structuredContent = card ? { ...result, _card: card } : result;
      const summary = card
        ? `Ticket #${card.id}: ${card.summary} (${card.priority ?? "no priority"}, ${card.status ?? "no status"})`
        : `Ticket #${id}`;
      return {
        content: [{ type: "text", text: summary }],
        structuredContent,
      };
    },
  );

  server.tool(
    "cw_create_ticket",
    "Create a new service ticket. Pass siteId (see cw_list_company_sites) for a multi-site company and ownerId (a member id from cw_search_members) to assign it on creation. The automaticEmail* flags are opt-in and sent only when set; Manage's own board notification settings for new tickets still apply and are not changed by this tool.",
    {
      summary: z.string().describe("Ticket summary/title"),
      boardId: z.number().optional().describe("Service board ID"),
      companyId: z.number().optional().describe("Company ID to associate"),
      contactId: z.number().optional().describe("Contact ID to associate"),
      statusId: z.number().optional().describe("Status ID"),
      priorityId: z.number().optional().describe("Priority ID"),
      typeId: z.number().optional().describe("Type ID"),
      subTypeId: z.number().optional().describe("SubType ID"),
      initialDescription: z.string().optional().describe("Initial ticket description"),
      siteId: z.number().int().positive().optional().describe("Company site ID (from cw_list_company_sites)"),
      ownerId: z.number().int().positive().optional().describe("Member ID to assign as ticket owner (from cw_search_members)"),
      automaticEmailContactFlag: z.boolean().optional().describe("Set the ticket's Automatic Email Contact flag. Sent only when provided."),
      automaticEmailResourceFlag: z.boolean().optional().describe("Set the ticket's Automatic Email Resource flag. Sent only when provided."),
      automaticEmailCcFlag: z.boolean().optional().describe("Set the ticket's Automatic Email Cc flag. Sent only when provided."),
      parentTicketId: z
        .number()
        .optional()
        .describe(
          "Parent ticket id (Manage Ticket.parentTicketId). When set, the new ticket is created as a child of this ticket. Omit to leave it unparented. Same field cw_get_ticket returns.",
        ),
    },
    ADDITIVE_WRITE,
    async ({
      summary, boardId, companyId, contactId, statusId, priorityId, typeId, subTypeId, initialDescription,
      siteId, ownerId, automaticEmailContactFlag, automaticEmailResourceFlag, automaticEmailCcFlag, parentTicketId,
    }) => {
      const body: Record<string, unknown> = { summary };
      if (boardId) body.board = { id: boardId };
      if (companyId) body.company = { id: companyId };
      if (contactId) body.contact = { id: contactId };
      if (statusId) body.status = { id: statusId };
      if (priorityId) body.priority = { id: priorityId };
      if (typeId) body.type = { id: typeId };
      if (subTypeId) body.subType = { id: subTypeId };
      if (initialDescription) body.initialDescription = initialDescription;
      if (siteId !== undefined) body.site = { id: siteId };
      if (ownerId !== undefined) body.owner = { id: ownerId };
      if (automaticEmailContactFlag !== undefined) body.automaticEmailContactFlag = automaticEmailContactFlag;
      if (automaticEmailResourceFlag !== undefined) body.automaticEmailResourceFlag = automaticEmailResourceFlag;
      if (automaticEmailCcFlag !== undefined) body.automaticEmailCcFlag = automaticEmailCcFlag;
      if (parentTicketId !== undefined) body.parentTicketId = parentTicketId;

      const result = await client.post("/service/tickets", body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_update_ticket",
    "Update an existing service ticket using JSON Patch operations.",
    {
      id: z.number().describe("Ticket ID"),
      operations: z
        .array(
          z.object({
            op: z.enum(["replace", "add", "remove"]).describe("Patch operation"),
            path: z.string().describe("JSON path (e.g. 'status/id', 'summary')"),
            value: z.unknown().optional().describe("New value"),
          }),
        )
        .describe("Array of JSON Patch operations"),
    },
    DESTRUCTIVE_WRITE,
    async ({ id, operations }) => {
      const result = await client.patch(`/service/tickets/${id}`, operations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_bundle_tickets",
    "WRITE. Bundle service tickets by attaching child tickets to a parent ticket in a single call to Manage's attachChildren endpoint (POST /service/tickets/{parentTicketId}/attachChildren). Manage applies its own bundling rules (for example, a parent cannot itself be a child). A rejection is returned as the error with isError set; the per-child outcome of a rejected request is not reported, so check the affected tickets with cw_get_ticket before retrying. A child that is already bundled under a different parent is moved to the new parent. This attaches children only; it does not merge ticket contents and does not detach children.",
    {
      parentTicketId: z.number().int().positive().describe("Ticket that the children are attached to"),
      childTicketIds: z
        .array(z.number().int().positive())
        .min(1)
        .describe("Tickets to attach to the parent. Must not include the parent; duplicates are ignored."),
    },
    DESTRUCTIVE_WRITE,
    async ({ parentTicketId, childTicketIds }) => {
      if (childTicketIds.includes(parentTicketId)) {
        return {
          content: [{ type: "text", text: `Ticket ${parentTicketId} cannot be bundled under itself.` }],
          isError: true,
        };
      }
      const uniqueChildIds = [...new Set(childTicketIds)];
      try {
        // Manage's action endpoints document a { success: boolean } body, so a 2xx
        // with success=false must not be reported as a successful bundle.
        const response = await client.post<{ success?: boolean } | undefined>(
          `/service/tickets/${parentTicketId}/attachChildren`,
          { childTicketIds: uniqueChildIds },
        );
        if (response?.success === false) {
          throw new Error("Manage reported success=false for attachChildren");
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ parentTicketId, success: false, childTicketIds: uniqueChildIds, error }, null, 2),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ parentTicketId, success: true, childTicketIds: uniqueChildIds }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "cw_get_ticket_notes",
    "Get all notes/discussions on a service ticket, including notes from any child tickets.",
    {
      id: z.number().describe("Ticket ID"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    READ_ONLY,
    async ({ id, page, pageSize }) => {
      try {
        const result = await client.get(`/service/tickets/${id}/allNotes`, {
          page: page ?? 1,
          pageSize: pageSize ?? 25,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        if (hasApiStatus(err, 404, 405)) {
          // allNotes not supported on this CWM version — fall back to /notes
          const result = await client.get(`/service/tickets/${id}/notes`, {
            page: page ?? 1,
            pageSize: pageSize ?? 25,
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        throw err;
      }
    },
  );

  server.registerTool(
    "cw_add_ticket_note",
    {
      annotations: ADDITIVE_WRITE,
      description:
        "Add a note to a service ticket. Use detailDescriptionFlag for a discussion note, internalAnalysisFlag for an internal-only note, or resolutionFlag for a resolution note. Defaults to a plain discussion note. Nothing is emailed unless processNotifications is true. emailContactFlag, emailResourceFlag, and emailCcFlag never default to true and are not sent: POST /service/tickets/{id}/notes (ServiceNote) does not have those fields (they belong to TimeEntry and to the ticket automaticEmail* fields). Sending them is what returns 400. A true flag only turns on processNotifications, unless you set processNotifications yourself. An explicit processNotifications false suppresses delivery even if a flag is true. When processNotifications is true and you did not set a type flag, this tool sets detailDescriptionFlag so Manage has a place to display the note. Recipients are the ticket's automaticEmailContactFlag, automaticEmailResourceFlag, automaticEmailCcFlag, and automaticEmailCc (cw_get_ticket / cw_update_ticket), not the note. emailCc is not sent; put CC addresses on the ticket automaticEmailCc field. To email one note and then stop, turn the ticket flag on, post with processNotifications true, then turn the flag off. memberId, when set, is sent as member.id and becomes the author. Omit memberId and Manage attributes the note to the API member that authenticated the call.",
      inputSchema: {
        id: z.number().describe("Ticket ID"),
        text: z.string().describe("Note text content"),
        detailDescriptionFlag: z.boolean().optional().describe("Add as detail description (discussion). Omit to leave unset, unless processNotifications is true and no type flag was set, in which case this tool sends true."),
        internalAnalysisFlag: z.boolean().optional().describe("Mark as internal analysis only (default: unset)"),
        resolutionFlag: z.boolean().optional().describe("Mark as resolution note (default: unset)"),
        customerUpdatedFlag: z.boolean().optional().describe("Flag that the customer was updated (default: unset)"),
        emailContactFlag: z
          .boolean()
          .optional()
          .describe("Request notification processing for the ticket contact. Not a ServiceNote field and never sent. Omit or false does not email. Never defaults to true. Recipients still come from the ticket automaticEmailContactFlag."),
        emailResourceFlag: z
          .boolean()
          .optional()
          .describe("Request notification processing for ticket resources. Not a ServiceNote field and never sent. Omit or false does not email. Never defaults to true."),
        emailCcFlag: z
          .boolean()
          .optional()
          .describe("Request notification processing for ticket CC. Not a ServiceNote field and never sent. Omit or false does not email. Never defaults to true. emailCc alone does not send mail."),
        emailCc: z
          .string()
          .optional()
          .describe("Not sent. ServiceNote has no emailCc. CC addresses belong on the ticket automaticEmailCc field. Does not email anyone by itself."),
        processNotifications: z
          .boolean()
          .optional()
          .describe("Manage ServiceNote processNotifications. Omit unless you need to force notification processing on or off. True sends using the ticket automaticEmail* settings. False suppresses delivery."),
        memberId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Author member id, sent as ServiceNote.member { id }. Omit to leave the author as the API member authenticated on the request. Never assumed."),
      },
      // MCP Apps (SEP-1865): the ticket card's "Add note" round-trip target.
      _meta: TICKET_CARD_META,
    },
    async ({
      id,
      text,
      detailDescriptionFlag,
      internalAnalysisFlag,
      resolutionFlag,
      customerUpdatedFlag,
      emailContactFlag,
      emailResourceFlag,
      emailCcFlag,
      emailCc,
      processNotifications,
      memberId,
    }) => {
      const body = buildTicketNoteBody({
        text,
        detailDescriptionFlag,
        internalAnalysisFlag,
        resolutionFlag,
        customerUpdatedFlag,
        emailContactFlag,
        emailResourceFlag,
        emailCcFlag,
        emailCc,
        processNotifications,
        memberId,
      });

      try {
        const result = await client.post<Record<string, unknown>>(`/service/tickets/${id}/notes`, body);
        const mapped = mapCreatedNoteResponse(result, {
          detailDescriptionFlag: body.detailDescriptionFlag === true ? true : detailDescriptionFlag,
          internalAnalysisFlag,
          resolutionFlag,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(mapped, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: msg }], isError: true as const };
      }
    },
  );
}
