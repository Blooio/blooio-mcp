import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
import { sha256Base64Url } from "../src/oauth.js";

const BASE = "https://mcp.test";
const REDIRECT_URI = "https://client.test/callback";
const VERIFIER = "client-verifier-0123456789-0123456789-0123456789";

function memoryKv(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function makeEnv(kvEntries) {
  return {
    OAUTH_STORAGE: memoryKv(kvEntries),
    UPSTREAM_BASE_URL: "https://api.test/v4",
    PUBLIC_URL: BASE,
    BLOOIO_OAUTH_CLIENT_ID: "bloapp_mcp",
    BLOOIO_OAUTH_CLIENT_SECRET: "blosec_test",
    ENVIRONMENT: "test",
  };
}

const request = (env, path, init) => app.request(`${BASE}${path}`, init, env);

const rpc = (env, message, authorization) =>
  request(env, "/v4", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
  });

/**
 * Stand-in for api.blooio.com. `organizations` are the orgs the Blooio MCP app
 * is installed on for the signing-in user; `api` answers /v4 calls.
 */
function fakeBlooio(t, { organizations = [{ id: "org_a", name: "Acme" }], api } = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const call = { url, method: init.method || "GET", headers, body: init.body };
    calls.push(call);

    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(init.body);
      call.form = form;
      if (form.get("grant_type") === "refresh_token") {
        return Response.json({
          access_token: "blo_at_2",
          refresh_token: "blo_rt_2",
          expires_in: 3600,
          scope: "messages:read",
        });
      }
      return Response.json({
        access_token: "blo_at_1",
        refresh_token: "blo_rt_1",
        expires_in: 3600,
        scope: "messages:read",
      });
    }
    if (url.pathname === "/v4/me" && headers.get("authorization") === "Bearer blo_at_1") {
      const orgId = headers.get("x-organization-id");
      if (!orgId && organizations.length > 1) {
        return Response.json(
          {
            error: {
              code: "organization_required",
              message: "specify X-Organization-Id",
              details: { organization_ids: organizations.map((o) => o.id) },
            },
          },
          { status: 400 },
        );
      }
      const org = orgId ? organizations.find((o) => o.id === orgId) : organizations[0];
      return Response.json({
        data: { organization_id: org.id, organization: { name: org.name } },
      });
    }
    return api(call);
  });
  return calls;
}

async function registerClient(env) {
  const res = await request(env, "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "<Claude>",
      redirect_uris: [REDIRECT_URI],
    }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function authorizeParams(clientId) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: "client-state",
    code_challenge: await sha256Base64Url(VERIFIER),
    code_challenge_method: "S256",
  };
}

/** Register, confirm, and return from Blooio consent; resolves to the callback response. */
async function signIn(env, calls) {
  const client = await registerClient(env);
  const params = await authorizeParams(client.client_id);

  const page = await request(env, `/oauth/authorize?${new URLSearchParams(params)}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /&lt;Claude&gt;/);
  assert.doesNotMatch(html, /<Claude>/);

  const handoff = await request(env, "/oauth/authorize", {
    method: "POST",
    body: new URLSearchParams(params),
  });
  assert.equal(handoff.status, 302);
  const upstream = new URL(handoff.headers.get("location"));
  assert.equal(upstream.origin + upstream.pathname, "https://api.test/oauth/authorize");
  assert.equal(upstream.searchParams.get("client_id"), "bloapp_mcp");
  assert.equal(upstream.searchParams.get("redirect_uri"), `${BASE}/oauth/callback`);
  assert.equal(upstream.searchParams.get("code_challenge_method"), "S256");

  const callback = await request(
    env,
    `/oauth/callback?code=blo_ac_1&state=${upstream.searchParams.get("state")}`,
    { headers: { accept: "text/html" } },
  );

  const exchange = calls.findLast((c) => c.url.pathname === "/oauth/token");
  assert.equal(exchange.form.get("client_secret"), "blosec_test");
  assert.equal(
    await sha256Base64Url(exchange.form.get("code_verifier")),
    upstream.searchParams.get("code_challenge"),
  );
  return { client, params, callback };
}

async function redeem(env, client, callback, verifier = VERIFIER) {
  const location = new URL(callback.headers.get("location"));
  assert.equal(location.searchParams.get("state"), "client-state");
  return request(env, "/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: location.searchParams.get("code"),
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
}

test("signing in with Blooio yields an org-pinned token that tools use", async (t) => {
  const env = makeEnv();
  const calls = fakeBlooio(t, {
    api: ({ url, headers }) => {
      assert.equal(url.pathname, "/v4/chats/chat_1");
      assert.equal(headers.get("authorization"), "Bearer blo_at_1");
      assert.equal(headers.get("x-organization-id"), "org_a");
      return Response.json({ data: { id: "chat_1" } });
    },
  });

  const { client, callback } = await signIn(env, calls);
  assert.equal(callback.status, 302);
  const tokens = await (await redeem(env, client, callback)).json();
  assert.equal(tokens.access_token, "bmcp_org_a.blo_at_1");
  assert.equal(tokens.refresh_token, "bmcp_org_a.blo_rt_1");
  assert.equal(tokens.expires_in, 3600);

  const res = await rpc(
    env,
    { id: 1, method: "tools/call", params: { name: "get_chat", arguments: { chat_id: "chat_1" } } },
    `Bearer ${tokens.access_token}`,
  );
  const body = await res.json();
  assert.deepEqual(JSON.parse(body.result.content[0].text), { data: { id: "chat_1" } });
});

test("a user with several installed orgs picks one for the connection", async (t) => {
  const env = makeEnv();
  const calls = fakeBlooio(t, {
    organizations: [
      { id: "org_a", name: "Acme" },
      { id: "org_b", name: "<Beta>" },
    ],
  });

  const { callback } = await signIn(env, calls);
  assert.equal(callback.status, 200);
  const html = await callback.text();
  assert.match(html, /&lt;Beta&gt;/);
  const pending = html.match(/name="pending" value="([^"]+)"/)[1];

  const tampered = await request(env, "/oauth/organization", {
    method: "POST",
    headers: { accept: "text/html" },
    body: new URLSearchParams({ pending, organization_id: "org_other" }),
  });
  assert.equal(tampered.status, 400);

  const { client, callback: retry } = await signIn(env, calls);
  const retryPending = (await retry.text()).match(/name="pending" value="([^"]+)"/)[1];
  const chosen = await request(env, "/oauth/organization", {
    method: "POST",
    body: new URLSearchParams({ pending: retryPending, organization_id: "org_b" }),
  });
  assert.equal(chosen.status, 302);
  const tokens = await (await redeem(env, client, chosen)).json();
  assert.equal(tokens.access_token, "bmcp_org_b.blo_at_1");
});

test("authorization codes require the client's PKCE verifier", async (t) => {
  const env = makeEnv();
  const calls = fakeBlooio(t);
  const { client, callback } = await signIn(env, calls);
  const res = await redeem(env, client, callback, "wrong-verifier");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant");
});

test("refresh is proxied to Blooio and stays on the pinned org", async (t) => {
  const env = makeEnv();
  const calls = fakeBlooio(t);
  const res = await request(env, "/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "bmcp_org_a.blo_rt_1",
      client_id: "blooio_anything",
    }),
  });
  const tokens = await res.json();
  assert.equal(tokens.access_token, "bmcp_org_a.blo_at_2");
  assert.equal(tokens.refresh_token, "bmcp_org_a.blo_rt_2");
  const upstream = calls.find((c) => c.url.pathname === "/oauth/token").form;
  assert.equal(upstream.get("refresh_token"), "blo_rt_1");
  assert.equal(upstream.get("client_id"), "bloapp_mcp");
  assert.equal(upstream.get("client_secret"), "blosec_test");
});

test("authorize rejects a redirect_uri the client did not register", async () => {
  const env = makeEnv();
  const client = await registerClient(env);
  const params = await authorizeParams(client.client_id);
  params.redirect_uri = "https://attacker.test/callback";
  const res = await request(env, `/oauth/authorize?${new URLSearchParams(params)}`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_request");
});

// Clients offer sign-in only when connecting (initialize) is refused.
test("connecting without credentials asks the client to sign in", async () => {
  const env = makeEnv();
  for (const method of ["initialize", "tools/list", "tools/call"]) {
    const res = await rpc(env, { id: 1, method, params: { name: "me" } });
    assert.equal(res.status, 401, method);
    assert.equal(
      res.headers.get("www-authenticate"),
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
    );
  }
});

test("an expired Blooio token surfaces as HTTP 401 so the client refreshes", async (t) => {
  const env = makeEnv();
  fakeBlooio(t, { api: () => Response.json({ error: { code: "invalid_token" } }, { status: 401 }) });
  const res = await rpc(
    env,
    { id: 1, method: "tools/call", params: { name: "me", arguments: {} } },
    "Bearer bmcp_org_a.blo_at_expired",
  );
  assert.equal(res.status, 401);
});

test("API errors come back as tool errors the model can read", async (t) => {
  const env = makeEnv();
  fakeBlooio(t, {
    api: () => Response.json({ error: { code: "invalid_content" } }, { status: 422 }),
  });
  const res = await rpc(
    env,
    { id: 1, method: "tools/call", params: { name: "send_message", arguments: { to: "+15551234567" } } },
    "Bearer bl_live_key",
  );
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /422.*invalid_content/);
});

test("tokens from the API-key sign-in keep resolving to their key", async (t) => {
  const env = makeEnv({
    "access_token:abc123": JSON.stringify({ api_key: "bl_live_legacy" }),
  });
  fakeBlooio(t, {
    api: ({ headers }) => {
      assert.equal(headers.get("authorization"), "Bearer bl_live_legacy");
      assert.equal(headers.get("x-organization-id"), null);
      return Response.json({ data: {} });
    },
  });
  const res = await rpc(
    env,
    { id: 1, method: "tools/call", params: { name: "me", arguments: {} } },
    "Bearer abc123",
  );
  assert.equal((await res.json()).result.isError, undefined);
});

test("initialize negotiates the protocol version and notifications get 202", async () => {
  const env = makeEnv();
  const key = "Bearer bl_live_key";
  const init = await (
    await rpc(env, { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, key)
  ).json();
  assert.equal(init.result.protocolVersion, "2025-03-26");

  const unknown = await (
    await rpc(env, { id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, key)
  ).json();
  assert.equal(unknown.result.protocolVersion, "2025-06-18");

  const notification = await rpc(env, { method: "notifications/initialized" }, key);
  assert.equal(notification.status, 202);
});
