/**
 * Contact type updates.
 *
 * Manage's Contact.typeIds is create-only. The model documents that existing
 * contacts change type through /company/contacts/{id}/typeAssociations (or
 * /company/contactTypeAssociations), not through PATCH /company/contacts/{id}.
 * cw_update_contact therefore rejects type paths, and cw_update_contact_types
 * adds or removes a ContactTypeAssociation.
 */

export const CONTACT_TYPE_PATCH_ERROR =
  'Contact types are a child collection and cannot be changed with cw_update_contact. Manage accepts typeIds only when creating a contact; updates go to POST or DELETE /company/contacts/{id}/typeAssociations. Use cw_update_contact_types (for example typeName "Decision Maker").';

const CONTACT_TYPE_PATCH_PATH = /^\/?(?:types|typeIds)(?:\/.*)?$/;

export function contactPatchTouchesTypes(path: string): boolean {
  return CONTACT_TYPE_PATCH_PATH.test(path);
}

export function assertContactPatchOperations(operations: { path: string }[]): void {
  if (operations.some((operation) => contactPatchTouchesTypes(operation.path))) {
    throw new Error(CONTACT_TYPE_PATCH_ERROR);
  }
}

/** ConnectWise conditions require double-quoted strings. */
export function quoteCwString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function contactTypeNameCondition(typeName: string): string {
  return `name = ${quoteCwString(typeName)}`;
}

export interface ContactTypeRecord {
  id?: number;
  name?: string;
}

export interface ContactTypeAssociation {
  id?: number;
  type?: { id?: number; name?: string };
  contact?: { id?: number };
}

export function pickContactType(
  types: ContactTypeRecord[],
  typeName: string,
): { id: number; name: string } {
  const wanted = typeName.trim().toLowerCase();
  const matches = types.filter(
    (type): type is { id: number; name: string } =>
      typeof type.id === "number" &&
      typeof type.name === "string" &&
      type.name.toLowerCase() === wanted,
  );
  if (matches.length === 1) return matches[0];
  const quoted = quoteCwString(typeName.trim());
  if (matches.length === 0) {
    throw new Error(
      `No contact type named ${quoted}. Names must match a type from GET /company/contacts/types.`,
    );
  }
  throw new Error(`Multiple contact types named ${quoted}. Pass typeId instead.`);
}

export function findTypeAssociations(
  associations: ContactTypeAssociation[],
  match: { typeId?: number; typeName?: string },
): ContactTypeAssociation[] {
  return associations.filter((association) => {
    const type = association.type;
    if (!type) return false;
    if (match.typeId !== undefined) return type.id === match.typeId;
    if (match.typeName) return type.name?.toLowerCase() === match.typeName.toLowerCase();
    return false;
  });
}

export function assertContactTypeUpdateArgs(input: {
  action: "add" | "remove";
  typeName?: string;
  typeId?: number;
  associationId?: number;
}): void {
  const typeName = input.typeName?.trim();
  if (input.action === "add") {
    if (input.typeId === undefined && !typeName) {
      throw new Error(
        'cw_update_contact_types action "add" requires typeId or typeName (for example "Decision Maker").',
      );
    }
    return;
  }
  if (input.associationId === undefined && input.typeId === undefined && !typeName) {
    throw new Error(
      'cw_update_contact_types action "remove" requires associationId, typeId, or typeName.',
    );
  }
}

export function asContactList<T>(value: unknown, what: string): T[] {
  if (Array.isArray(value)) return value as T[];
  throw new Error(`ConnectWise returned an unexpected ${what} payload (expected a list).`);
}
