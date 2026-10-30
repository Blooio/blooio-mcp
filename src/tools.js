// MCP tools for the Blooio v4 API.
//
// Every API operation becomes one tool, compiled from the OpenAPI spec into
// ./operations.json by scripts/sync-spec.mjs. A tool's arguments are the
// operation's path parameters (snake_case), query parameters, headers
// (camelCase), and the top-level request body fields, flattened together.
// Running a tool turns its arguments back into a request; ./mcp-handlers.js
// sends it.
import compiled from "./operations.json" with { type: "json" };

/** Arguments a tool rejected; reported to the model so it can correct the call. */
export class ToolInputError extends Error {}

// Arguments the hand-written 4.0 tools accepted that the API now spells differently.
const LEGACY_ARG_ADAPTERS = {
  update_channel_profile: ({ profile, ...args }) => ({ ...profile, ...args }),
};

function checkArgs(name, schema, args) {
  const accepted = Object.keys(schema.properties);
  const unknown = Object.keys(args).filter((k) => !accepted.includes(k));
  if (unknown.length) {
    throw new ToolInputError(
      `Unknown argument(s) for ${name}: ${unknown.join(", ")}. Accepted: ${accepted.join(", ")}.`,
    );
  }
  const missing = (schema.required || []).filter(
    (k) => args[k] === undefined || args[k] === null || args[k] === "",
  );
  if (missing.length) {
    throw new ToolInputError(
      `Missing required argument(s) for ${name}: ${missing.join(", ")}.`,
    );
  }
}

/**
 * The upstream request for an operation's tool arguments:
 * `{ method, path, headers, body?, bodyType?, fileFields }`, with `path`
 * relative to the API base and including the query string.
 */
export function buildRequest(op, rawArgs) {
  const adapt = LEGACY_ARG_ADAPTERS[op.name];
  const args = adapt ? adapt(rawArgs) : rawArgs;
  checkArgs(op.name, op.inputSchema, args);

  let path = op.path;
  for (const { name, arg } of op.pathParams) {
    path = path.replace(`{${name}}`, encodeURIComponent(String(args[arg])));
  }
  const query = new URLSearchParams();
  for (const name of op.queryParams) {
    if (args[name] !== undefined) query.set(name, String(args[name]));
  }
  if (query.size) path += `?${query}`;

  const headers = {};
  for (const { name, arg } of op.headerParams) {
    if (args[arg] !== undefined) headers[name] = String(args[arg]);
  }

  if (!op.body) return { method: op.method, path, headers, fileFields: [] };
  const body = Object.fromEntries(
    op.body.fields.filter((f) => args[f] !== undefined).map((f) => [f, args[f]]),
  );
  return {
    method: op.method,
    path,
    headers,
    body,
    bodyType: op.body.type,
    fileFields: op.body.fileFields,
  };
}

export const API_VERSION = compiled.api_version;

const OPERATIONS = new Map(compiled.operations.map((op) => [op.name, op]));

const operationTools = compiled.operations.map((op) => ({
  name: op.name,
  description: op.description,
  inputSchema: op.inputSchema,
  annotations: op.annotations,
  run: (args, send) => send(buildRequest(op, args)),
}));

const contactCapabilitiesSchema = {
  type: "object",
  properties: {
    contact: {
      type: "string",
      description: "Phone number (E.164, e.g. +15551234567) or email.",
    },
    channel_type: {
      type: "string",
      description: "Channel type for a newly created contact (default 'blooio').",
    },
  },
  required: ["contact"],
  additionalProperties: false,
};

// Composite convenience tool kept from 4.0: capabilities by raw identifier.
const contactCapabilities = {
  name: "contact_capabilities",
  description:
    "Check if a phone number or email is reachable via iMessage / SMS / RCS. Resolves (or creates) the contact for that identifier, then returns its capabilities. Creating the contact is a side effect.",
  inputSchema: contactCapabilitiesSchema,
  annotations: {
    title: "Check capabilities for a phone number or email",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  run: async (args, send) => {
    checkArgs("contact_capabilities", contactCapabilitiesSchema, args);
    const call = (name, toolArgs) => send(buildRequest(OPERATIONS.get(name), toolArgs));
    const found = await call("list_contacts", { identifier: args.contact, limit: 1 });
    const contactId =
      found.data[0]?.id ??
      (
        await call("create_contact", {
          identifier: args.contact,
          channel_type: args.channel_type || "blooio",
        })
      ).data.id;
    return call("get_contact_capabilities", { contact_id: contactId });
  },
};

export const TOOLS = [...operationTools, contactCapabilities];
export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
