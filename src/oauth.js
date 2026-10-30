// OAuth for MCP clients, delegated to Blooio's own OAuth server.
//
// MCP clients register here (RFC 7591) and run an authorization-code + PKCE
// flow against this server. After a confirmation page naming the client, the
// user is sent to Blooio's consent screen as the "Blooio MCP" app; the Blooio
// tokens that come back are pinned to one organization and handed to the
// client wrapped as `bmcp_<organization_id>.<blooio token>`. Tool calls unwrap
// the token and send the org as X-Organization-Id, so a user who installs the
// app on several orgs keeps each connection on the org they chose.

export const KV_PREFIX_CLIENT = "client:";
export const KV_PREFIX_PENDING_AUTH = "pending_auth:";
export const KV_PREFIX_PENDING_ORG = "pending_org:";
export const KV_PREFIX_AUTH_CODE = "auth_code:";
// Tokens minted by the API-key sign-in this server used before Blooio OAuth;
// they live up to 90 days and still resolve to the stored key.
export const KV_PREFIX_LEGACY_ACCESS_TOKEN = "access_token:";

export const PENDING_TTL_SECONDS = 600;
const MCP_TOKEN_PREFIX = "bmcp_";

export const MCP_SCOPES = [
  "messages:read",
  "messages:write",
  "chats:read",
  "chats:write",
  "channels:read",
  "channels:write",
  "contacts:read",
  "contacts:write",
  "groups:read",
  "groups:write",
  "webhooks:read",
  "webhooks:write",
  "events:read",
  "tickets:read",
  "tickets:write",
  "numbers:read",
  "numbers:manage",
  "calls:read",
  "calls:write",
];

/** An OAuth protocol error, rendered as JSON for clients and HTML for browsers. */
export class OAuthError extends Error {
  constructor(code, description, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

export function randomToken(bytes = 32) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64Url(input) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function getBaseUrl(env, req) {
  return env.PUBLIC_URL || `https://${req.header("host")}`;
}

export function blooioOAuthUrl(env, path) {
  return `${new URL(env.UPSTREAM_BASE_URL).origin}/oauth/${path}`;
}

export function wrapToken(organizationId, token) {
  return `${MCP_TOKEN_PREFIX}${organizationId}.${token}`;
}

/** `{ organizationId, token }` for a wrapped token, else null. */
export function unwrapToken(value) {
  if (!value.startsWith(MCP_TOKEN_PREFIX)) return null;
  const rest = value.slice(MCP_TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot < 1) return null;
  return { organizationId: rest.slice(0, dot), token: rest.slice(dot + 1) };
}

/**
 * Headers that authenticate an upstream API call for the MCP caller's
 * Authorization header, or null when the caller sent no credentials.
 */
export async function resolveUpstreamAuth(env, authorizationHeader) {
  const token = (authorizationHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const wrapped = unwrapToken(token);
  if (wrapped) {
    return {
      Authorization: `Bearer ${wrapped.token}`,
      "X-Organization-Id": wrapped.organizationId,
    };
  }

  const isApiKey = token.startsWith("bl_");
  const isBlooioAppToken = token.startsWith("blo_");
  if (isApiKey || isBlooioAppToken) return { Authorization: `Bearer ${token}` };

  const legacy = await env.OAUTH_STORAGE.get(
    KV_PREFIX_LEGACY_ACCESS_TOKEN + token,
  );
  if (!legacy) return { Authorization: `Bearer ${token}` };
  // Early records stored the bare key; later ones a JSON object.
  const apiKey = legacy.startsWith("{") ? JSON.parse(legacy).api_key : legacy;
  return { Authorization: `Bearer ${apiKey}` };
}

// ---------------------------------------------------------------------------
// HTML pages
// ---------------------------------------------------------------------------

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_STYLE = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0f; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
body::before { content: ""; position: fixed; inset: 0; pointer-events: none; background: radial-gradient(500px at 25% 25%, rgba(0,102,255,0.14), transparent), radial-gradient(400px at 75% 75%, rgba(255,107,0,0.08), transparent); }
.card { position: relative; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); backdrop-filter: blur(20px); border-radius: 20px; padding: 40px; max-width: 480px; width: 100%; }
.logo { width: 48px; height: 48px; margin: 0 auto 24px; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #0066FF, #0088FF); box-shadow: 0 8px 24px rgba(0,102,255,0.25); }
h1 { font-size: 24px; font-weight: 700; text-align: center; letter-spacing: -0.02em; margin-bottom: 10px; }
p { color: rgba(255,255,255,0.55); font-size: 15px; line-height: 1.55; text-align: center; margin-bottom: 24px; }
strong { color: #fff; font-weight: 600; }
.option { display: flex; align-items: center; gap: 12px; padding: 14px 16px; margin-bottom: 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); cursor: pointer; font-size: 15px; }
.option:has(input:checked) { border-color: #0066FF; background: rgba(0,102,255,0.1); }
button, .button { display: block; width: 100%; padding: 14px; margin-top: 8px; border: none; border-radius: 12px; font-size: 15px; font-weight: 600; color: #fff; text-align: center; text-decoration: none; cursor: pointer; background: linear-gradient(135deg, #0066FF, #0088FF); box-shadow: 0 8px 24px rgba(0,102,255,0.25); }
.secondary { background: transparent; box-shadow: none; color: rgba(255,255,255,0.55); }
`;

const LOGO = `<div class="logo"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>`;

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body><main class="card">${LOGO}${body}</main></body>
</html>`;
}

function hiddenFields(fields) {
  return Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
}

/** Confirmation shown before handing off to Blooio, naming who asked. */
export function connectPage({ clientName, redirectHost, params, cancelUrl }) {
  return page(
    "Connect to Blooio",
    `<h1>Connect ${esc(clientName)} to Blooio</h1>
<p><strong>${esc(clientName)}</strong> (${esc(redirectHost)}) wants to use the Blooio MCP server on your behalf. Next you'll sign in to Blooio and choose which organization and permissions to share.</p>
<form method="POST" action="/oauth/authorize">${hiddenFields(params)}<button type="submit">Continue to Blooio</button></form>
<a class="button secondary" href="${esc(cancelUrl)}">Cancel</a>`,
  );
}

export function organizationPickerPage({ pendingId, clientName, organizations }) {
  const options = organizations
    .map(
      (org, i) =>
        `<label class="option"><input type="radio" name="organization_id" value="${esc(org.organization_id)}"${i === 0 ? " checked" : ""}>${esc(org.name)}</label>`,
    )
    .join("");
  return page(
    "Choose an organization",
    `<h1>Choose an organization</h1>
<p>Blooio MCP is installed on more than one of your organizations. Pick the one <strong>${esc(clientName)}</strong> should use.</p>
<form method="POST" action="/oauth/organization">${hiddenFields({ pending: pendingId })}${options}<button type="submit">Continue</button></form>`,
  );
}

export function errorPage(message) {
  return page(
    "Blooio MCP authorization failed",
    `<h1>Authorization failed</h1><p>${esc(message)}</p>`,
  );
}
