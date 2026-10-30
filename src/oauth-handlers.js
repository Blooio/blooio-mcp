// OAuth 2.0 routes for MCP clients. The flow is described in ./oauth.js.
import {
  KV_PREFIX_CLIENT,
  KV_PREFIX_PENDING_AUTH,
  KV_PREFIX_PENDING_ORG,
  KV_PREFIX_AUTH_CODE,
  PENDING_TTL_SECONDS,
  MCP_SCOPES,
  OAuthError,
  randomToken,
  sha256Base64Url,
  getBaseUrl,
  blooioOAuthUrl,
  wrapToken,
  unwrapToken,
  connectPage,
  organizationPickerPage,
} from "./oauth.js";

const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
];
const UNSAFE_REDIRECT_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
]);
const EXPIRED_MESSAGE =
  "This sign-in has expired. Start connecting again from your MCP client.";

// Native MCP clients register custom schemes (cursor://, vscode://); plain
// http is only accepted for loopback.
function isValidRedirectUri(uri) {
  if (typeof uri !== "string" || !URL.canParse(uri)) return false;
  const url = new URL(uri);
  if (UNSAFE_REDIRECT_SCHEMES.has(url.protocol)) return false;
  if (url.protocol !== "http:") return true;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

function clientRedirect(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

const callbackUrl = (c) => `${getBaseUrl(c.env, c.req)}/oauth/callback`;

async function putPending(env, key, value) {
  await env.OAUTH_STORAGE.put(key, JSON.stringify(value), {
    expirationTtl: PENDING_TTL_SECONDS,
  });
}

/** Read a single-use KV record and delete it. */
async function takePending(env, key) {
  const value = await env.OAUTH_STORAGE.get(key, "json");
  if (value) await env.OAUTH_STORAGE.delete(key);
  return value;
}

async function getClient(env, clientId) {
  const client =
    clientId && (await env.OAUTH_STORAGE.get(KV_PREFIX_CLIENT + clientId, "json"));
  if (!client) {
    throw new OAuthError(
      "invalid_client",
      "Unknown client_id. Remove and re-add the Blooio MCP server in your client so it registers again.",
    );
  }
  return client;
}

async function validateAuthorizeRequest(env, params) {
  if (params.response_type !== "code") {
    throw new OAuthError("unsupported_response_type", "response_type must be code.");
  }
  const client = await getClient(env, params.client_id);
  if (!client.redirect_uris.includes(params.redirect_uri)) {
    throw new OAuthError(
      "invalid_request",
      "redirect_uri is not registered for this client.",
    );
  }
  if (!params.code_challenge || params.code_challenge_method !== "S256") {
    throw new OAuthError(
      "invalid_request",
      "PKCE with code_challenge_method=S256 is required.",
    );
  }
  return client;
}

/** Exchange a grant at Blooio's token endpoint as the Blooio MCP app. */
async function requestBlooioTokens(env, grant) {
  const res = await fetch(blooioOAuthUrl(env, "token"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...grant,
      client_id: env.BLOOIO_OAUTH_CLIENT_ID,
      client_secret: env.BLOOIO_OAUTH_CLIENT_SECRET,
    }),
  });
  if (res.status >= 500) {
    throw new Error(`Blooio token endpoint returned ${res.status}`);
  }
  const body = await res.json();
  if (!res.ok) {
    throw new OAuthError(body.code || "invalid_grant", body.message, res.status);
  }
  return body;
}

/**
 * The organizations a fresh Blooio token can act on. A token covers every org
 * this user installed the app on; /me names the org when there is one and
 * lists them (organization_required) when there are several.
 */
async function listGrantedOrganizations(env, accessToken) {
  const fetchMe = (organizationId) =>
    fetch(`${env.UPSTREAM_BASE_URL}/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(organizationId ? { "X-Organization-Id": organizationId } : {}),
      },
    });

  const res = await fetchMe();
  const body = await res.json();
  if (res.ok) {
    return [
      {
        organization_id: body.data.organization_id,
        name: body.data.organization.name,
      },
    ];
  }
  if (body.error?.code !== "organization_required") {
    throw new Error(`Blooio /me returned ${res.status}: ${body.error?.message}`);
  }
  return Promise.all(
    body.error.details.organization_ids.map(async (organizationId) => {
      const orgRes = await fetchMe(organizationId);
      if (!orgRes.ok) {
        throw new Error(`Blooio /me for ${organizationId} returned ${orgRes.status}`);
      }
      const { data } = await orgRes.json();
      return { organization_id: organizationId, name: data.organization.name };
    }),
  );
}

function tokenResponse(organizationId, tokens) {
  return {
    access_token: wrapToken(organizationId, tokens.access_token),
    token_type: "Bearer",
    expires_in: tokens.expires_in,
    refresh_token: wrapToken(organizationId, tokens.refresh_token),
    scope: tokens.scope,
  };
}

async function issueAuthorizationCode(c, pending, tokens, organizationId) {
  const code = randomToken();
  await putPending(c.env, KV_PREFIX_AUTH_CODE + code, {
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    code_challenge: pending.code_challenge,
    token: tokenResponse(organizationId, tokens),
  });
  return c.redirect(
    clientRedirect(pending.redirect_uri, { code, state: pending.state }),
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// RFC 7591 Dynamic Client Registration. MCP clients are public (PKCE, no secret).
export async function handleRegister(c) {
  const body = await c.req.json().catch(() => {
    throw new OAuthError("invalid_client_metadata", "Body must be JSON.");
  });
  const redirectUris = body.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every(isValidRedirectUri)
  ) {
    throw new OAuthError(
      "invalid_redirect_uri",
      "redirect_uris must list at least one https, custom-scheme, or loopback URL.",
    );
  }
  const client = {
    client_id: `blooio_${randomToken()}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: body.client_name || "An MCP client",
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  await c.env.OAUTH_STORAGE.put(
    KV_PREFIX_CLIENT + client.client_id,
    JSON.stringify(client),
  );
  return c.json(client, 201);
}

export async function handleAuthorizeGet(c) {
  const params = c.req.query();
  const client = await validateAuthorizeRequest(c.env, params);
  const redirect = new URL(params.redirect_uri);
  return c.html(
    connectPage({
      clientName: client.client_name,
      redirectHost: redirect.host || redirect.protocol,
      params: Object.fromEntries(
        AUTHORIZE_PARAMS.filter((k) => params[k]).map((k) => [k, params[k]]),
      ),
      cancelUrl: clientRedirect(params.redirect_uri, {
        error: "access_denied",
        state: params.state,
      }),
    }),
  );
}

// The user confirmed on the connect page: hand off to Blooio's consent screen.
export async function handleAuthorizePost(c) {
  const params = await c.req.parseBody();
  await validateAuthorizeRequest(c.env, params);

  const pendingId = randomToken();
  const verifier = randomToken();
  await putPending(c.env, KV_PREFIX_PENDING_AUTH + pendingId, {
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    state: params.state,
    code_challenge: params.code_challenge,
    verifier,
  });

  const upstream = new URL(blooioOAuthUrl(c.env, "authorize"));
  upstream.search = new URLSearchParams({
    response_type: "code",
    client_id: c.env.BLOOIO_OAUTH_CLIENT_ID,
    redirect_uri: callbackUrl(c),
    scope: MCP_SCOPES.join(" "),
    state: pendingId,
    code_challenge: await sha256Base64Url(verifier),
    code_challenge_method: "S256",
  }).toString();
  return c.redirect(upstream.toString());
}

// Blooio redirects here after consent.
export async function handleCallback(c) {
  const { code, state, error } = c.req.query();
  const pending =
    state && (await takePending(c.env, KV_PREFIX_PENDING_AUTH + state));
  if (!pending) throw new OAuthError("invalid_request", EXPIRED_MESSAGE);
  if (error || !code) {
    return c.redirect(
      clientRedirect(pending.redirect_uri, {
        error: error || "access_denied",
        state: pending.state,
      }),
    );
  }

  const tokens = await requestBlooioTokens(c.env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(c),
    code_verifier: pending.verifier,
  });
  const organizations = await listGrantedOrganizations(c.env, tokens.access_token);
  if (organizations.length === 1) {
    return issueAuthorizationCode(c, pending, tokens, organizations[0].organization_id);
  }

  const client = await getClient(c.env, pending.client_id);
  const pendingId = randomToken();
  await putPending(c.env, KV_PREFIX_PENDING_ORG + pendingId, {
    pending,
    tokens,
    organizations,
  });
  return c.html(
    organizationPickerPage({
      pendingId,
      clientName: client.client_name,
      organizations,
    }),
  );
}

export async function handleOrganizationPost(c) {
  const { pending: pendingId, organization_id: organizationId } =
    await c.req.parseBody();
  const choice =
    pendingId && (await takePending(c.env, KV_PREFIX_PENDING_ORG + pendingId));
  if (!choice) throw new OAuthError("invalid_request", EXPIRED_MESSAGE);
  if (!choice.organizations.some((o) => o.organization_id === organizationId)) {
    throw new OAuthError("invalid_request", "Choose one of the listed organizations.");
  }
  return issueAuthorizationCode(c, choice.pending, choice.tokens, organizationId);
}

async function redeemAuthorizationCode(env, params) {
  const grant =
    params.code && (await takePending(env, KV_PREFIX_AUTH_CODE + params.code));
  if (!grant?.token) {
    throw new OAuthError("invalid_grant", "Invalid or expired authorization code.");
  }
  if (
    grant.client_id !== params.client_id ||
    grant.redirect_uri !== params.redirect_uri
  ) {
    throw new OAuthError(
      "invalid_grant",
      "client_id or redirect_uri does not match the authorization request.",
    );
  }
  const challenge =
    params.code_verifier && (await sha256Base64Url(params.code_verifier));
  if (challenge !== grant.code_challenge) {
    throw new OAuthError("invalid_grant", "PKCE verification failed.");
  }
  return grant.token;
}

async function refreshTokens(env, params) {
  const wrapped = params.refresh_token && unwrapToken(params.refresh_token);
  if (!wrapped) throw new OAuthError("invalid_grant", "Unknown refresh token.");
  const tokens = await requestBlooioTokens(env, {
    grant_type: "refresh_token",
    refresh_token: wrapped.token,
  });
  return tokenResponse(wrapped.organizationId, tokens);
}

export async function handleToken(c) {
  const params = await c.req.parseBody();
  if (params.grant_type === "authorization_code") {
    return c.json(await redeemAuthorizationCode(c.env, params));
  }
  if (params.grant_type === "refresh_token") {
    return c.json(await refreshTokens(c.env, params));
  }
  throw new OAuthError(
    "unsupported_grant_type",
    "grant_type must be authorization_code or refresh_token.",
  );
}
