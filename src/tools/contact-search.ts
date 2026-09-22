/**
 * Contact search query builder.
 *
 * Manage GET /company/contacts accepts `conditions` for parent fields and
 * `childConditions` for child collections. Contact `types` is an array of
 * ContactTypeReference (`id`, `name`), so `types` / `types/name` in
 * `conditions` returns 400 ApiFindCondition. There is no contact field
 * named `name` (use `firstName` / `lastName`). String literals must use
 * double quotes; single quotes also raise ApiFindCondition.
 */

export interface ContactSearchInput {
  conditions?: string;
  childConditions?: string;
  /** Contact type name. Sent as childConditions `types/name="..."`. */
  typeName?: string;
  /** Contact type id. Sent as childConditions `types/id=<id>`. */
  typeId?: number;
}

export interface ContactSearchQuery {
  conditions?: string;
  childConditions?: string;
}

interface Clause {
  joiner: "and" | "or" | null;
  text: string;
}

function cwQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Convert single-quoted CW string literals to double quotes. */
export function normalizeCwQuotes(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === '"') {
      out += c;
      i++;
      while (i < input.length) {
        const d = input[i];
        out += d;
        i++;
        if (d === "\\") {
          if (i < input.length) {
            out += input[i];
            i++;
          }
          continue;
        }
        if (d === '"') break;
      }
      continue;
    }
    if (c === "'") {
      i++;
      let value = "";
      while (i < input.length) {
        if (input[i] === "\\" && input[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (input[i] === "'") {
          i++;
          break;
        }
        value += input[i];
        i++;
      }
      out += cwQuote(value);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function splitClauses(input: string): Clause[] {
  const clauses: Clause[] = [];
  let start = 0;
  let joiner: "and" | "or" | null = null;
  let quote: '"' | "'" | null = null;
  let paren = 0;

  const push = (end: number) => {
    const text = input.slice(start, end).trim();
    if (text) clauses.push({ joiner, text });
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === "\\" && i + 1 < input.length) {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(") {
      paren++;
      continue;
    }
    if (c === ")") {
      paren = Math.max(0, paren - 1);
      continue;
    }
    if (paren === 0 && /\s/.test(c)) {
      const match = input.slice(i).match(/^\s+(and|or)\s+/i);
      if (match) {
        push(i);
        joiner = match[1].toLowerCase() as "and" | "or";
        i += match[0].length - 1;
        start = i + 1;
      }
    }
  }
  push(input.length);
  return clauses;
}

function joinClauses(clauses: Clause[]): string | undefined {
  if (clauses.length === 0) return undefined;
  let out = clauses[0].text;
  for (let i = 1; i < clauses.length; i++) {
    out += ` ${clauses[i].joiner ?? "and"} ${clauses[i].text}`;
  }
  return out;
}

const OPERATOR =
  /^([\w./]+)\s*(!=|<=|>=|=|<|>|contains|like|not\s+in|in)\s*([\s\S]+)$/i;

function isTypesField(field: string): boolean {
  return field === "types" || field.startsWith("types/");
}

/**
 * `types = "Primary"` is not valid on the parent. The child field is
 * `types/name` for strings and `types/id` for numbers.
 */
function rewriteTypesClause(clause: string): string {
  const match = clause.match(OPERATOR);
  if (!match) return clause;
  const field = match[1];
  const op = match[2];
  const value = match[3].trim();
  if (field !== "types") return clause;
  if (/^"[\s\S]*"$/.test(value)) return `types/name ${op} ${value}`;
  if (/^-?\d+$/.test(value)) return `types/id ${op} ${value}`;
  return clause;
}

/** Contact has firstName/lastName, not `name`. `company/name` is left alone. */
function rewriteBareName(clause: string): string {
  const match = clause.match(OPERATOR);
  if (!match) return clause;
  if (match[1] !== "name") return clause;
  const op = match[2];
  const value = match[3].trim();
  return `(firstName ${op} ${value} or lastName ${op} ${value})`;
}

export function buildContactSearchQuery(input: ContactSearchInput): ContactSearchQuery {
  const parent: Clause[] = [];
  const child: Clause[] = [];

  if (input.conditions) {
    for (const clause of splitClauses(normalizeCwQuotes(input.conditions))) {
      const match = clause.text.match(OPERATOR);
      const field = match?.[1] ?? "";
      if (isTypesField(field)) {
        child.push({ joiner: child.length === 0 ? null : clause.joiner, text: rewriteTypesClause(clause.text) });
      } else {
        parent.push({
          joiner: parent.length === 0 ? null : clause.joiner,
          text: rewriteBareName(clause.text),
        });
      }
    }
  }

  if (input.childConditions) {
    const normalized = normalizeCwQuotes(input.childConditions).trim();
    if (normalized) {
      child.push({ joiner: child.length === 0 ? null : "and", text: normalized });
    }
  }
  if (input.typeId !== undefined) {
    child.push({
      joiner: child.length === 0 ? null : "and",
      text: `types/id=${input.typeId}`,
    });
  }
  if (input.typeName) {
    child.push({
      joiner: child.length === 0 ? null : "and",
      text: `types/name=${cwQuote(input.typeName)}`,
    });
  }

  return {
    conditions: joinClauses(parent),
    childConditions: joinClauses(child),
  };
}
