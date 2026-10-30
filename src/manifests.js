// MCP manifest for the Blooio v4 API, derived from the tool registry so it
// never drifts from what tools/call supports.
import { TOOLS, API_VERSION } from "./tools.js";
import { MCP_SCOPES } from "./oauth.js";

export const V4_MANIFEST = {
  name: "blooio-mcp",
  version: "4.1.0",
  api_version: API_VERSION,
  description:
    "Send and receive messages across iMessage, SMS, RCS, and WhatsApp through the Blooio v4 API. Manage channels, numbers, contacts, chats, messages, reactions, polls, groups, calls, 10DLC registration, support tickets, webhooks, and the unified event feed.",
  base_path: "/v4",
  auth: {
    type: "oauth2",
    authorization_url: "/oauth/authorize",
    token_url: "/oauth/token",
    scopes: MCP_SCOPES,
  },
  tools: TOOLS.map((t) => ({
    name: t.name,
    summary: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  })),
};

export function getManifest(env) {
  return { ...V4_MANIFEST, upstream: env.UPSTREAM_BASE_URL };
}
