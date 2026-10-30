// Compiles the Blooio v4 OpenAPI spec into src/operations.json, the compact
// operation list the MCP server turns into tools.
//
//   node scripts/sync-spec.mjs [spec-path-or-url]
//
// Defaults to the monorepo's backend spec; outside the monorepo pass
// https://docs.blooio.com/openapi.v4.json (the same document).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mcpRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MONOREPO_SPEC = resolve(
  mcpRoot,
  "../workers/backend/src/v4/openapi.json",
);
export const OUTPUT = join(mcpRoot, "src/operations.json");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

// API-key management only accepts OAuth app tokens, and the MCP app does not
// request the apikeys scopes, so these could never succeed through the MCP.
const EXCLUDED_TAGS = new Set(["API Keys"]);

// Alternate spellings of an operation that already has a tool.
const SKIPPED_OPERATIONS = new Set([
  "refreshLocationContactsGet",
  "lookupPhoneNumberPost",
]);

// Names published by the hand-written 4.0 tool set; clients may call them.
const TOOL_NAME_OVERRIDES = {
  getMe: "me",
  attachContactIdentity: "add_contact_identity",
  detachContactIdentity: "remove_contact_identity",
  sendMessageToChat: "send_chat_message",
  getChatMessage: "get_message",
};

const DROPPED_SCHEMA_KEYS = new Set([
  "example",
  "examples",
  "discriminator",
  "$schema",
  "xml",
  "externalDocs",
]);

const MAX_TOOL_DESCRIPTION = 1200;
const MAX_FIELD_DESCRIPTION = 400;
const MAX_NESTING = 1;

const snake = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();

const camel = (s) =>
  s.toLowerCase().replace(/[-_]+([a-z0-9])/g, (_, c) => c.toUpperCase());

/** First paragraph, capped, so tool listings stay small enough for a model's context. */
function trimDescription(text, max) {
  if (!text) return undefined;
  const first = text.trim().split(/\n\s*\n/)[0].trim();
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

function makeResolver(spec) {
  const lookup = (ref) =>
    ref
      .replace(/^#\//, "")
      .split("/")
      .reduce((node, key) => node[key], spec);

  // Inline every $ref; a ref already on the current path is recursive and
  // becomes an unconstrained schema. Below MAX_NESTING object levels a schema
  // keeps only its type and description, so one rich-content field cannot
  // dominate the tool listing; the API's 422 names any malformed field.
  function resolveSchema(node, depth = 0, seen = new Set()) {
    if (Array.isArray(node)) return node.map((n) => resolveSchema(n, depth, seen));
    if (!node || typeof node !== "object") return node;
    if (node.$ref) {
      if (seen.has(node.$ref)) return {};
      return resolveSchema(lookup(node.$ref), depth, new Set([...seen, node.$ref]));
    }
    if (depth > MAX_NESTING && (node.properties || node.items || node.oneOf || node.anyOf || node.allOf)) {
      return {
        ...(node.type ? { type: node.type } : {}),
        ...(node.description
          ? { description: trimDescription(node.description, MAX_FIELD_DESCRIPTION) }
          : {}),
      };
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (DROPPED_SCHEMA_KEYS.has(key) || key.startsWith("x-")) continue;
      if (key === "description") {
        out.description = trimDescription(value, MAX_FIELD_DESCRIPTION);
      } else if (key === "properties") {
        out.properties = Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, resolveSchema(v, depth + 1, seen)]),
        );
      } else {
        out[key] = resolveSchema(value, depth, seen);
      }
    }
    return out;
  }

  const resolveRef = (node) => (node?.$ref ? lookup(node.$ref) : node);
  return { resolveSchema, resolveRef };
}

/** Merge an object body's allOf members into one property map. */
function flattenObject(schema) {
  const properties = { ...schema.properties };
  const required = [...(schema.required || [])];
  for (const member of schema.allOf || []) {
    const flat = flattenObject(member);
    Object.assign(properties, flat.properties);
    required.push(...flat.required);
  }
  return { properties, required };
}

function compileBody(op, resolveSchema) {
  const content = op.requestBody?.content;
  if (!content) return null;
  if (content["application/json"]) {
    const schema = resolveSchema(content["application/json"].schema);
    return { type: "json", ...flattenObject(schema), fileFields: [] };
  }
  if (content["multipart/form-data"]) {
    const schema = resolveSchema(content["multipart/form-data"].schema);
    const { properties, required } = flattenObject(schema);
    const fileFields = Object.keys(properties).filter(
      (k) => properties[k].format === "binary",
    );
    for (const field of fileFields) {
      properties[field] = {
        type: "string",
        description: "Public URL of the file to upload.",
      };
    }
    return { type: "multipart", properties, required, fileFields };
  }
  throw new Error(
    `${op.operationId}: unsupported request content ${Object.keys(content)}`,
  );
}

function annotationsFor(method, summary) {
  const readOnly = method === "get";
  return {
    title: summary,
    readOnlyHint: readOnly,
    destructiveHint: method === "delete",
    openWorldHint: true,
  };
}

function compileOperation(path, method, op, pathItem, resolver) {
  const { resolveSchema, resolveRef } = resolver;
  const params = [...(pathItem.parameters || []), ...(op.parameters || [])].map(
    resolveRef,
  );
  const properties = {};
  const required = [];
  const pathParams = [];
  const queryParams = [];
  const headerParams = [];

  const addArg = (arg, schema, description, isRequired) => {
    if (properties[arg]) {
      throw new Error(`${op.operationId}: argument "${arg}" is defined twice`);
    }
    properties[arg] = {
      ...resolveSchema(schema || { type: "string" }),
      ...(description
        ? { description: trimDescription(description, MAX_FIELD_DESCRIPTION) }
        : {}),
    };
    if (isRequired) required.push(arg);
  };

  for (const p of params) {
    if (p.in === "path") {
      const arg = snake(p.name);
      pathParams.push({ name: p.name, arg });
      addArg(arg, p.schema, p.description, true);
    } else if (p.in === "query") {
      queryParams.push(p.name);
      addArg(p.name, p.schema, p.description, p.required);
    } else if (p.in === "header") {
      const arg = camel(p.name);
      headerParams.push({ name: p.name, arg });
      addArg(arg, p.schema, p.description, p.required);
    }
  }

  const body = compileBody(op, resolveSchema);
  if (body) {
    for (const [field, schema] of Object.entries(body.properties)) {
      addArg(field, schema, undefined, body.required.includes(field));
    }
  }

  const description = [op.summary, trimDescription(op.description, MAX_TOOL_DESCRIPTION)]
    .filter(Boolean)
    .join("\n\n");

  return {
    name: TOOL_NAME_OVERRIDES[op.operationId] || snake(op.operationId),
    operationId: op.operationId,
    description,
    annotations: annotationsFor(method, op.summary),
    method: method.toUpperCase(),
    path,
    pathParams,
    queryParams,
    headerParams,
    body: body && {
      type: body.type,
      fields: Object.keys(body.properties),
      fileFields: body.fileFields,
    },
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
  };
}

export function compileOperations(spec) {
  const resolver = makeResolver(spec);
  const operations = [];
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      if (op.deprecated || op["x-blooio-status"] === "planned") continue;
      if (SKIPPED_OPERATIONS.has(op.operationId)) continue;
      if ((op.tags || []).some((t) => EXCLUDED_TAGS.has(t))) continue;
      operations.push(compileOperation(path, method, op, pathItem, resolver));
    }
  }
  const names = operations.map((o) => o.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) throw new Error(`Duplicate tool name: ${duplicate}`);
  return {
    api_version: spec.info.version,
    server: spec.servers[0].url,
    operations,
  };
}

async function loadSpec(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Fetching ${source} failed: ${res.status}`);
    return res.json();
  }
  if (!existsSync(source)) throw new Error(`Spec not found at ${source}`);
  return JSON.parse(readFileSync(source, "utf8"));
}

export function serialize(compiled) {
  return `${JSON.stringify(compiled, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = process.argv[2] || MONOREPO_SPEC;
  const compiled = compileOperations(await loadSpec(source));
  writeFileSync(OUTPUT, serialize(compiled));
  console.log(
    `[sync-spec] ${compiled.operations.length} operations from ${source} (API ${compiled.api_version})`,
  );
}
