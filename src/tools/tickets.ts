import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { buildTicketCard, TICKET_CARD_META } from "../card.builder.js";
import { buildTicketNoteBody, mapCreatedNoteResponse } from "./note-payload.js";

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
    "Search service tickets in ConnectWise Manage. Use 'conditions' for CW query syntax (e.g. \"status/name != 'Closed'\" or \"company/name = 'Acme'\").",
    {
      conditions: z
        .string()
        .optional()
        .describe("ConnectWise conditions query string"),
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
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/service/tickets", {
        conditions,
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
    "Create a new service ticket.",
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
      parentTicketId: z
        .number()
        .optional()
        .describe(
          "Parent ticket id (Manage Ticket.parentTicketId). When set, the new ticket is created as a child of this ticket. Omit to leave it unparented. Same field cw_get_ticket returns.",
        ),
    },
    async ({ summary, boardId, companyId, contactId, statusId, priorityId, typeId, subTypeId, initialDescription, parentTicketId }) => {
      const body: Record<string, unknown> = { summary };
      if (boardId) body.board = { id: boardId };
      if (companyId) body.company = { id: companyId };
      if (contactId) body.contact = { id: contactId };
      if (statusId) body.status = { id: statusId };
      if (priorityId) body.priority = { id: priorityId };
      if (typeId) body.type = { id: typeId };
      if (subTypeId) body.subType = { id: subTypeId };
      if (initialDescription) body.initialDescription = initialDescription;
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
    async ({ id, operations }) => {
      const result = await client.patch(`/service/tickets/${id}`, operations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
    async ({ id, page, pageSize }) => {
      try {
        const result = await client.get(`/service/tickets/${id}/allNotes`, {
          page: page ?? 1,
          pageSize: pageSize ?? 25,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("404") || msg.includes("405")) {
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
      description:
        "Add a note to a service ticket. Use detailDescriptionFlag for a discussion note, internalAnalysisFlag for an internal-only note, or resolutionFlag for a resolution note. Defaults to a plain discussion note. Email is off unless you set a flag: emailContactFlag emails the ticket contact, emailResourceFlag emails resources, and emailCcFlag emails the addresses in emailCc. Those fields are forwarded only when set — omitting them does not email anyone. Manage sends the mail when processNotifications is true; this tool sets that only if an email flag is true, or if you set processNotifications yourself. An explicit processNotifications false suppresses delivery even if a flag is true. Ticket-level recipient defaults are automaticEmailContactFlag, automaticEmailResourceFlag, automaticEmailCcFlag, and automaticEmailCc (see cw_get_ticket / cw_update_ticket).",
      inputSchema: {
        id: z.number().describe("Ticket ID"),
        text: z.string().describe("Note text content"),
        detailDescriptionFlag: z.boolean().optional().describe("Add as detail description (default: false)"),
        internalAnalysisFlag: z.boolean().optional().describe("Mark as internal analysis only (default: false)"),
        resolutionFlag: z.boolean().optional().describe("Mark as resolution note (default: false)"),
        customerUpdatedFlag: z.boolean().optional().describe("Flag that the customer was updated (default: false)"),
        emailContactFlag: z
          .boolean()
          .optional()
          .describe("Email the ticket contact. Omit to not email the contact. Never defaults to true."),
        emailResourceFlag: z
          .boolean()
          .optional()
          .describe("Email ticket resources. Omit to not email resources. Never defaults to true."),
        emailCcFlag: z
          .boolean()
          .optional()
          .describe("Email the addresses in emailCc. Omit to not email CC. Never defaults to true. emailCc alone does not send mail."),
        emailCc: z
          .string()
          .optional()
          .describe("CC email addresses. Sent only when provided. Does not email anyone unless emailCcFlag is true."),
        processNotifications: z
          .boolean()
          .optional()
          .describe("Manage ServiceNote processNotifications. Omit unless you need to force notification processing on or off. True sends using the ticket automaticEmail* settings. False suppresses delivery."),
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
      });

      const result = await client.post<Record<string, unknown>>(`/service/tickets/${id}/notes`, body);
      const mapped = mapCreatedNoteResponse(result, {
        detailDescriptionFlag,
        internalAnalysisFlag,
        resolutionFlag,
      });
      return { content: [{ type: "text", text: JSON.stringify(mapped, null, 2) }] };
    },
  );
}
