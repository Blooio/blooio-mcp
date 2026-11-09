# Blooio MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for the [Blooio v4 API](https://docs.blooio.com). It lets Claude, ChatGPT, Cursor, and any other MCP client send and receive iMessage, SMS, RCS, and WhatsApp messages, and manage channels, numbers, contacts, chats, groups, calls, 10DLC registration, support tickets, webhooks, and the event feed.

It is a thin wrapper: every tool is one Blooio API call, made with the credentials of the person who connected.

## Connect

Add this server URL to your MCP client:

```
https://mcp.blooio.com/v4
```

The client opens a browser window where you sign in to Blooio, choose the organization to connect, and approve the permissions. Access tokens refresh automatically; you can revoke access any time from your organization's installed apps in the [Blooio dashboard](https://app.blooio.com).

If your client can't do OAuth, send a Blooio API key instead:

```
Authorization: Bearer bl_live_...
```

## Tools

There is one tool per [v4 API operation](https://docs.blooio.com), generated from the published OpenAPI spec, so the tool set always matches the docs. Tool arguments are the operation's:

- path parameters, in `snake_case` (`/chats/{chatId}` takes `chat_id`)
- query parameters
- request body fields, flattened to the top level
- `idempotencyKey`, for operations that accept an `Idempotency-Key` header

Operations that upload a file (`set_group_icon`, `set_chat_background`, `upload_contact_card_avatar`) take a public URL; the server downloads it and uploads it to Blooio.

When a call fails, the API's error comes back as the tool result, so the model can read it and fix the call.

Resources (`blooio://account/info`, `blooio://channels`, `blooio://webhooks`) and a few starter prompts (`send_quick_message`, `check_delivery`, `send_with_attachment`, `verify_contact`, `setup_webhook`, `start_group_chat`) are also available.

## How sign-in works

The server is an OAuth 2.1 authorization server for MCP clients: dynamic client registration, authorization code with PKCE (S256), and refresh tokens. It delegates the actual login to Blooio's OAuth:

1. The MCP client registers at `/oauth/register` and opens `/oauth/authorize`.
2. A confirmation page names the client and where it will be redirected, then hands off to Blooio's consent screen as the **Blooio MCP** app.
3. Blooio redirects back to `/oauth/callback`, which only continues in the browser that confirmed step 2 (a short-lived `__Host-` cookie), so a consent link someone else started can't hand them your tokens. If the app is installed on several of the user's organizations, the server asks which one this connection should use.
4. The client receives Blooio's tokens wrapped with that organization (`bmcp_<organization_id>.<token>`), so every tool call is pinned to the chosen organization. The server stores no long-lived tokens; refresh requests are forwarded to Blooio.

Discovery documents are served at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`. Calls without valid credentials get `401` with a `WWW-Authenticate` header pointing at the latter.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /v4` | MCP JSON-RPC (Streamable HTTP, JSON responses) |
| `GET /v4/manifest` | Tools, resources, and prompts as JSON |
| `POST /v4/call` | One tool call without JSON-RPC framing: `{ "tool": "...", "arguments": {...} }` |
| `ALL /v4/<path>` | Pass-through to `https://api.blooio.com/v4/<path>` |
| `/oauth/*`, `/.well-known/*` | OAuth and discovery |

## Development

Requires Node 22+.

```bash
npm install
npm test            # unit tests
npm start           # wrangler dev on http://localhost:8787
```

To run sign-in locally, create a Blooio app in the dashboard (Developers → Apps) with redirect URI `http://localhost:8787/oauth/callback`, put its client id in `wrangler.toml` as `BLOOIO_OAUTH_CLIENT_ID`, and its secret in `.dev.vars`:

```
BLOOIO_OAUTH_CLIENT_SECRET=blosec_...
```

Then point the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:8787/v4`.

### Updating the tools

`src/operations.json` is compiled from the OpenAPI spec. To regenerate it:

```bash
npm run sync-spec -- https://docs.blooio.com/openapi.v4.json
```

### ChatGPT plugin

`plugin/` is the package submitted to the OpenAI plugin directory: listing metadata in `plugin/plugin.json`. It has no `mcp.json` because the plugin reuses the MCP connection of its existing OpenAI app (`asdk_app_6944a7f832388191a71b8c68ee393f9e`), and the portal rejects packages that declare one. Without a declared server the package can't carry review test cases, so enter those in the portal under Review details. Build the upload with `npm run plugin:zip`, which writes `blooio-plugin.zip`. Bump `version` in `plugin.json` for every new upload.

## License

[Apache 2.0](LICENSE)
