import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  handleRegister,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleCallback,
  handleOrganizationPost,
  handleToken,
} from "./oauth-handlers.js";
import {
  createSender,
  mcpToolsList,
  mcpCallTool,
  mcpResourcesList,
  mcpReadResource,
  mcpPromptsList,
  mcpGetPrompt,
  UpstreamError,
} from "./mcp-handlers.js";
import { ToolInputError } from "./tools.js";
import { getManifest, V4_MANIFEST } from "./manifests.js";
import {
  MCP_SCOPES,
  OAuthError,
  errorPage,
  getBaseUrl,
  resolveUpstreamAuth,
} from "./oauth.js";

// Newest first; an unknown requested version is answered with the newest.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// Each message in a batch can be an upstream API call.
const MAX_BATCH_SIZE = 20;

const SERVER_INSTRUCTIONS =
  "Blooio sends and receives iMessage, SMS, RCS, and WhatsApp messages. Call `me` to see the connected organization, `list_channels` for senders, and `send_message` to message a phone number or email (omit `from` for automatic routing). Conversations are chats (chat_...); read them with `list_chats` and `list_chat_messages`.";

/** The caller has no usable credentials; answered with HTTP 401 so the client signs in. */
class AuthenticationRequired extends Error {}

const app = new Hono();

app.use("*", cors({ exposeHeaders: ["WWW-Authenticate"] }));

// =============================================================================
// Root and health
// =============================================================================

app.get("/", (c) =>
  c.json({
    status: "Up!",
    service: "blooio-mcp",
    env: c.env.ENVIRONMENT,
    mcp: { base_path: "/v4", upstream: c.env.UPSTREAM_BASE_URL },
    timestamp: new Date().toISOString(),
  }),
);

app.get("/health", (c) => c.text("ok"));

// =============================================================================
// OAuth 2.0
// =============================================================================

app.use("/oauth/*", async (c, next) => {
  await next();
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", "frame-ancestors 'none'");
});

app.post("/oauth/register", handleRegister);
app.get("/oauth/authorize", handleAuthorizeGet);
app.post("/oauth/authorize", handleAuthorizePost);
app.get("/oauth/callback", handleCallback);
app.post("/oauth/organization", handleOrganizationPost);
app.post("/oauth/token", handleToken);

function authorizationServerMetadata(baseUrl) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    scopes_supported: MCP_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: `${baseUrl}/.well-known/mcp.json`,
  };
}

// RFC 8414; some MCP clients only probe the OpenID Connect discovery path.
app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json(authorizationServerMetadata(getBaseUrl(c.env, c.req))),
);
app.get("/.well-known/openid-configuration", (c) =>
  c.json(authorizationServerMetadata(getBaseUrl(c.env, c.req))),
);

function protectedResourceMetadata(c) {
  const baseUrl = getBaseUrl(c.env, c.req);
  return c.json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: `${baseUrl}/.well-known/mcp.json`,
  });
}

// RFC 9728, at the root and at the path-suffixed location for the /v4 endpoint.
app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
app.get("/.well-known/oauth-protected-resource/*", protectedResourceMetadata);

app.get("/.well-known/mcp.json", (c) => {
  const baseUrl = getBaseUrl(c.env, c.req);
  return c.json({
    name: V4_MANIFEST.name,
    version: V4_MANIFEST.version,
    description: V4_MANIFEST.description,
    mcp: {
      version: SUPPORTED_PROTOCOL_VERSIONS[0],
      transport: { type: "http", url: "/v4" },
      endpoints: { manifest: "/v4/manifest" },
      auth: {
        type: "oauth2",
        authorization_url: `${baseUrl}/oauth/authorize`,
        token_url: `${baseUrl}/oauth/token`,
        scopes: MCP_SCOPES,
      },
    },
  });
});

// OpenAI Apps domain verification (public by design).
app.get("/.well-known/openai-apps-challenge", (c) =>
  c.text("-2O1BLXo6-jKZBr8ycdEQrYBm5oLHcLSK_aEYN4Gn64"),
);

// =============================================================================
// MCP v4
// =============================================================================

async function senderFor(c) {
  const auth = await resolveUpstreamAuth(c.env, c.req.header("authorization"));
  if (!auth) throw new AuthenticationRequired();
  return createSender(c.env, auth);
}

/** Run an upstream-backed call; a rejected credential becomes a 401 for the client. */
async function withUpstream(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 401) {
      throw new AuthenticationRequired();
    }
    throw err;
  }
}

const isCallerError = (err) =>
  err instanceof ToolInputError || err instanceof UpstreamError;

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

// Tool failures go back as results so the model can read and correct them.
async function callToolResult(send, params) {
  try {
    const result = await withUpstream(() =>
      mcpCallTool(send, params.name, params.arguments || {}),
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    if (!isCallerError(err)) throw err;
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
}

async function readResourceResult(send, params) {
  const data = await withUpstream(() => mcpReadResource(send, params.uri));
  return {
    contents: [
      {
        uri: params.uri,
        mimeType: "application/json",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function initializeResult(params) {
  const requested = params.protocolVersion;
  return {
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : SUPPORTED_PROTOCOL_VERSIONS[0],
    serverInfo: {
      name: V4_MANIFEST.name,
      title: "Blooio",
      version: V4_MANIFEST.version,
    },
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: SERVER_INSTRUCTIONS,
  };
}

const RPC_METHODS = {
  initialize: (send, params) => initializeResult(params),
  ping: () => ({}),
  "tools/list": () => mcpToolsList(),
  "tools/call": (send, params) => callToolResult(send, params),
  "resources/list": () => mcpResourcesList(),
  "resources/read": (send, params) => readResourceResult(send, params),
  "prompts/list": () => mcpPromptsList(),
  "prompts/get": (send, params) => mcpGetPrompt(params.name, params.arguments),
};

const REQUIRED_PARAMS = {
  "tools/call": "name",
  "resources/read": "uri",
  "prompts/get": "name",
};

/** One JSON-RPC message; null for notifications, which get no response. */
async function handleRpc(send, message) {
  const { id, method, params = {} } = message || {};
  if (id === undefined || id === null) return null;
  const handler = RPC_METHODS[method];
  if (!handler) return rpcError(id, -32601, `Method not found: ${method}`);
  const required = REQUIRED_PARAMS[method];
  if (required && !params[required]) {
    return rpcError(id, -32602, `Invalid params for ${method}: missing ${required}`);
  }
  try {
    return rpcResult(id, await handler(send, params));
  } catch (err) {
    if (!isCallerError(err)) throw err;
    return rpcError(id, -32000, err.message);
  }
}

// Streamable HTTP clients open a server-to-client stream with GET and reconnect
// whenever it ends; 405 is the spec's answer for a server that offers none.
app.get("/v4", (c) => c.body(null, 405, { Allow: "POST" }));

// Every message needs credentials: MCP clients offer sign-in only when the
// connection itself (initialize) is refused with a 401.
app.post("/v4", async (c) => {
  const send = await senderFor(c);
  const payload = await c.req.json().catch(() => undefined);
  if (payload === undefined) return c.json(rpcError(null, -32700, "Parse error"));
  const messages = [payload].flat();
  if (messages.length > MAX_BATCH_SIZE) {
    return c.json(
      rpcError(null, -32600, `Batches are limited to ${MAX_BATCH_SIZE} messages`),
      400,
    );
  }

  const responses = [];
  for (const message of messages) {
    const response = await handleRpc(send, message);
    if (response) responses.push(response);
  }
  if (responses.length === 0) return c.body(null, 202);
  return c.json(Array.isArray(payload) ? responses : responses[0]);
});

app.get("/v4/manifest", (c) => c.json(getManifest(c.env)));

// Manifest stream for clients that discover tools over SSE.
app.get("/v4/sse", (c) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event, payload) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
        );
      send("manifest", getManifest(c.env));
      send("ready", { message: "mcp ready" });
      const interval = setInterval(() => send("ping", { t: Date.now() }), 15000);
      c.req.raw.signal.addEventListener("abort", () => clearInterval(interval));
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
});

// Single tool call without JSON-RPC framing.
app.post("/v4/call", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const toolName = body.tool || body.name;
  if (!toolName) return c.json({ error: "Missing tool" }, 400);
  const send = await senderFor(c);
  try {
    const result = await withUpstream(() =>
      mcpCallTool(send, toolName, body.arguments || body.args || {}),
    );
    return c.json({ result });
  } catch (err) {
    if (!isCallerError(err)) throw err;
    return c.json({ error: err.message }, 502);
  }
});

// Direct API pass-through: /v4/<path> -> <upstream>/<path>.
app.all("/v4/*", async (c) => {
  const reqUrl = new URL(c.req.url);
  const auth = await resolveUpstreamAuth(c.env, c.req.header("authorization"));
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("authorization");
  for (const [name, value] of Object.entries(auth || {})) headers.set(name, value);
  headers.set("x-forwarded-host", reqUrl.host);
  headers.set("x-blooio-proxy", "mcp");

  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
  const upstream = await fetch(
    `${c.env.UPSTREAM_BASE_URL}${reqUrl.pathname.slice("/v4".length)}${reqUrl.search}`,
    {
      method: c.req.method,
      headers,
      body: hasBody ? c.req.raw.body : undefined,
      redirect: "manual",
    },
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  });
});

// =============================================================================
// Legacy /v3 -> /v4 redirects
// =============================================================================
// 308 preserves the method and body, which MCP JSON-RPC POSTs need.
function redirectV3ToV4(c) {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/v3(?=\/|$)/, "/v4");
  return c.redirect(url.toString(), 308);
}
app.all("/v3", redirectV3ToV4);
app.all("/v3/*", redirectV3ToV4);

// =============================================================================
// Error boundary
// =============================================================================

app.notFound((c) => c.json({ error: "Not found" }, 404));

const wantsHtml = (c) => (c.req.header("accept") || "").includes("text/html");

app.onError((err, c) => {
  if (err instanceof AuthenticationRequired) {
    const baseUrl = getBaseUrl(c.env, c.req);
    return c.json(
      {
        error: "invalid_token",
        error_description: "Sign in to Blooio to use this server.",
      },
      401,
      {
        "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      },
    );
  }
  if (err instanceof OAuthError) {
    return wantsHtml(c)
      ? c.html(errorPage(err.message), err.status)
      : c.json({ error: err.code, error_description: err.message }, err.status);
  }
  console.error("MCP error:", err);
  if (c.req.method === "POST" && c.req.path === "/v4") {
    return c.json(rpcError(null, -32603, "Internal error"));
  }
  return wantsHtml(c)
    ? c.html(errorPage("Something went wrong. Start connecting again from your MCP client."), 500)
    : c.json({ error: "Internal Server Error" }, 500);
});

export default app;
