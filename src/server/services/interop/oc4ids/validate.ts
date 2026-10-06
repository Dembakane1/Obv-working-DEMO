/**
 * A small, deterministic JSON-Schema (draft-04 dialect) validator for the
 * vendored OC4IDS subset. Zero dependencies. It implements exactly the
 * keywords `OC4IDS_SCHEMA_COVERAGE.validatorKeywords` lists and nothing
 * else; the keyword list is published with every validation report so a
 * reader knows precisely what "valid" means here.
 *
 * Errors carry a JSON-pointer path, the keyword that failed and a plain
 * message. Open-codelist values outside the known list are WARNINGS (the
 * standard permits them), never errors.
 */
import { OPEN_CODELISTS, type JsonSchema } from "./schema";

export interface ValidationProblem {
  path: string;
  keyword: string;
  message: string;
}

export interface ValidationWarning {
  path: string;
  codelist: string;
  value: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationProblem[];
  warnings: ValidationWarning[];
}

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(declared: string | string[], value: unknown): boolean {
  const actual = typeOf(value);
  const allowed = Array.isArray(declared) ? declared : [declared];
  return allowed.some((t) => t === actual || (t === "number" && actual === "integer"));
}

/** True only for a real calendar instant: every component is range-checked
 *  by round-tripping through Date.UTC (2025-02-30 or 24:00 fail). */
export function isRealDateTime(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || t.getUTCHours() !== h || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== s) {
    return false;
  }
  if (m[7] !== "Z" && (Number(m[8]) > 23 || Number(m[9]) > 59)) return false;
  return true;
}

function formatOk(format: JsonSchema["format"], value: string): boolean {
  if (format === "date-time") return RFC3339.test(value) && isRealDateTime(value);
  if (format === "email") return EMAIL.test(value);
  if (format === "uri") {
    try {
      const u = new URL(value);
      return Boolean(u.protocol) && /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol);
    } catch {
      return false;
    }
  }
  return true;
}

function resolveRef(root: JsonSchema, refValue: string): JsonSchema {
  const m = /^#\/definitions\/([A-Za-z0-9_]+)$/.exec(refValue);
  const target = m ? root.definitions?.[m[1]] : undefined;
  if (!target) throw new Error(`Unresolvable $ref in vendored schema: ${refValue}`);
  return target;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

/** Validate `value` against `schema` (with `$ref`s resolved from `root`). */
export function validateAgainst(root: JsonSchema, value: unknown, schema: JsonSchema = root, path = ""): ValidationReport {
  const errors: ValidationProblem[] = [];
  const warnings: ValidationWarning[] = [];
  walk(root, schema, value, path || "/", errors, warnings);
  return { valid: errors.length === 0, errors, warnings };
}

function walk(
  rootIn: JsonSchema,
  schemaIn: JsonSchema,
  value: unknown,
  path: string,
  errors: ValidationProblem[],
  warnings: ValidationWarning[]
): void {
  // A nested schema that carries its own definitions (the project schema
  // embedded in the package schema) resolves its $refs against itself.
  const root = schemaIn.definitions ? schemaIn : rootIn;
  const schema = schemaIn.$ref ? { ...resolveRef(root, schemaIn.$ref), ...withoutRef(schemaIn) } : schemaIn;
  const here = path === "/" ? "" : path;

  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    errors.push({
      path: here || "/",
      keyword: "type",
      message: `expected ${Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type}, got ${typeOf(value)}`,
    });
    return; // further keywords assume the declared type
  }
  if (value === null || value === undefined) return;

  if (schema.enum && typeof value === "string" && !schema.enum.includes(value)) {
    errors.push({ path: here || "/", keyword: "enum", message: `"${value}" is not one of ${schema.enum.join(", ")}` });
  }
  if (schema.codelist && schema.openCodelist && typeof value === "string") {
    const name = schema.codelist.replace(/\.csv$/, "");
    const known = OPEN_CODELISTS[name];
    if (known && !known.includes(value)) {
      warnings.push({ path: here || "/", codelist: schema.codelist, value, message: `"${value}" is not in the known ${name} codelist (open codelist — permitted, review recommended)` });
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path: here || "/", keyword: "minLength", message: `must be at least ${schema.minLength} character(s)` });
    }
    if (schema.format && !formatOk(schema.format, value)) {
      errors.push({ path: here || "/", keyword: "format", message: `"${value}" is not a valid ${schema.format}` });
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path: here || "/", keyword: "minimum", message: `must be >= ${schema.minimum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path: here || "/", keyword: "minItems", message: `must contain at least ${schema.minItems} item(s)` });
    }
    if (schema.uniqueItems) {
      const seen = new Set<string>();
      value.forEach((item, i) => {
        const key = stable(item);
        if (seen.has(key)) errors.push({ path: `${here}/${i}`, keyword: "uniqueItems", message: "duplicate item" });
        seen.add(key);
      });
    }
    if (schema.items) {
      value.forEach((item, i) => walk(root, schema.items!, item, `${here}/${i}`, errors, warnings));
    }
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (obj[req] === undefined) {
        errors.push({ path: `${here}/${req}`, keyword: "required", message: `"${req}" is required` });
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] !== undefined) walk(root, sub, obj[key], `${here}/${key}`, errors, warnings);
    }
  }
}

function withoutRef(s: JsonSchema): JsonSchema {
  const { $ref: _ignored, ...rest } = s;
  void _ignored;
  return rest;
}

/** Deterministic canonical JSON: sorted object keys, no whitespace. The
 *  same records always serialize to the same bytes, which is what makes
 *  an export hash reproducible. */
export function canonicalJson(value: unknown): string {
  return stable(value);
}
