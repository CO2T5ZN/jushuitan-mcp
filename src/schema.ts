import type { ParamRow } from "./types.js";

/** Loose JSON-Schema shape used by the Jushuitan doc API. */
interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  required?: string[];
  description?: string;
  mock?: { mock?: unknown };
}

/**
 * Flatten a JSON-Schema string into table rows, mirroring the doc site's
 * expandable table: `（根）` is the biz root, nesting shown as `a.b` / `a[].b`.
 */
export function flattenSchema(schemaStr: string | null | undefined): ParamRow[] {
  if (!schemaStr) return [];
  let root: JsonSchemaNode;
  try {
    root = JSON.parse(schemaStr) as JsonSchemaNode;
  } catch {
    return [];
  }
  const rows: ParamRow[] = [];
  const walk = (node: JsonSchemaNode, prefix: string, isRequired: boolean): void => {
    rows.push({
      path: prefix || "（根）",
      type: node.type ?? "",
      required: isRequired,
      example: node.mock?.mock != null ? String(node.mock.mock) : "",
      description: node.description ?? "",
    });
    if (node.type === "object" && node.properties) {
      const req = Array.isArray(node.required) ? node.required : [];
      for (const [k, v] of Object.entries(node.properties)) {
        walk(v, prefix ? `${prefix}.${k}` : k, req.includes(k));
      }
    } else if (node.type === "array" && node.items && typeof node.items === "object") {
      const it = node.items;
      const base = prefix ? `${prefix}[]` : "";
      if (it.type === "object" && it.properties) {
        const req = Array.isArray(it.required) ? it.required : [];
        for (const [k, v] of Object.entries(it.properties)) {
          walk(v, base ? `${base}.${k}` : k, req.includes(k));
        }
      } else if (it.type) {
        rows.push({
          path: base || `${prefix}[]`,
          type: it.type,
          required: false,
          example: it.mock?.mock != null ? String(it.mock.mock) : "",
          description: it.description ?? "",
        });
      }
    }
  };
  walk(root, "", false);
  return rows;
}
