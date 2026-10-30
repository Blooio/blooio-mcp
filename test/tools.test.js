import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import compiled from "../src/operations.json" with { type: "json" };
import { TOOLS_BY_NAME, buildRequest, ToolInputError } from "../src/tools.js";
import {
  compileOperations,
  serialize,
  MONOREPO_SPEC,
  OUTPUT,
} from "../scripts/sync-spec.mjs";

const op = (name) => compiled.operations.find((o) => o.name === name);

// Every tool the hand-written 4.0 server published.
const TOOLS_4_0 = [
  "me", "list_numbers", "list_channels", "get_channel", "get_channel_capabilities",
  "update_channel_profile", "list_contacts", "create_contact", "get_contact",
  "update_contact", "delete_contact", "get_contact_capabilities", "contact_capabilities",
  "get_contact_timeline", "list_contact_identities", "add_contact_identity",
  "remove_contact_identity", "list_contact_tags", "add_contact_tags", "remove_contact_tag",
  "list_chats", "create_chat", "get_chat", "update_chat", "mark_chat_read", "set_typing",
  "share_contact_card", "get_chat_background", "remove_chat_background",
  "list_chat_messages", "send_message", "send_chat_message", "get_message",
  "get_message_status", "list_message_events", "add_reaction", "send_poll", "vote_poll",
  "get_poll_results", "list_groups", "create_group", "get_group", "update_group",
  "delete_group", "list_group_members", "remove_group_icon", "list_webhooks",
  "create_webhook", "get_webhook", "update_webhook", "delete_webhook",
  "rotate_webhook_secret", "list_webhook_deliveries", "replay_webhook_delivery",
  "list_events", "get_event", "lookup_phone_number", "batch_lookup_phone_numbers",
  "list_location_contacts", "refresh_location_contacts", "get_location_contact",
];

test("every 4.0 tool name is still served", () => {
  const missing = TOOLS_4_0.filter((name) => !TOOLS_BY_NAME.has(name));
  assert.deepEqual(missing, []);
});

test("operations.json matches the backend OpenAPI spec", { skip: !existsSync(MONOREPO_SPEC) }, () => {
  const spec = JSON.parse(readFileSync(MONOREPO_SPEC, "utf8"));
  assert.equal(
    readFileSync(OUTPUT, "utf8"),
    serialize(compileOperations(spec)),
    "Run `pnpm sync-spec` in apps/mcp after changing the v4 OpenAPI spec.",
  );
});

test("send_message keeps its 4.0 arguments, including idempotencyKey", () => {
  const req = buildRequest(op("send_message"), {
    to: "+15551234567",
    text: "hi",
    attachments: ["https://example.com/a.png"],
    idempotencyKey: "k1",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/messages");
  assert.deepEqual(req.headers, { "Idempotency-Key": "k1" });
  assert.deepEqual(req.body, {
    to: "+15551234567",
    text: "hi",
    attachments: ["https://example.com/a.png"],
  });
});

test("path parameters are snake_case and URL-encoded", () => {
  const req = buildRequest(op("get_message"), {
    chat_id: "chat_1",
    message_id: "msg/2",
  });
  assert.equal(req.path, "/chats/chat_1/messages/msg%2F2");
  assert.equal(req.body, undefined);
});

test("query parameters go on the path", () => {
  const req = buildRequest(op("list_chats"), { state: "open", limit: 5 });
  assert.equal(req.path, "/chats?state=open&limit=5");
});

test("update_channel_profile still accepts the 4.0 profile object", () => {
  const req = buildRequest(op("update_channel_profile"), {
    channel: "+15551234567",
    profile: { display_name: "Support" },
  });
  assert.equal(req.method, "PUT");
  assert.deepEqual(req.body, { display_name: "Support" });
});

test("file fields of multipart operations are sent as multipart", () => {
  const req = buildRequest(op("set_group_icon"), {
    group_id: "grp_1",
    icon: "https://example.com/icon.png",
  });
  assert.equal(req.bodyType, "multipart");
  assert.deepEqual(req.fileFields, ["icon"]);
});

test("unknown and missing arguments are rejected with the accepted list", () => {
  assert.throws(
    () => buildRequest(op("get_chat"), { chat_id: "chat_1", bogus: 1 }),
    (err) => err instanceof ToolInputError && /bogus/.test(err.message) && /chat_id/.test(err.message),
  );
  assert.throws(
    () => buildRequest(op("get_chat"), {}),
    (err) => err instanceof ToolInputError && /chat_id/.test(err.message),
  );
});

test("contact_capabilities creates the contact only when none exists", async () => {
  const requests = [];
  const send = async (req) => {
    requests.push(`${req.method} ${req.path}`);
    if (req.path.startsWith("/contacts?")) return { data: [] };
    if (req.path === "/contacts") return { data: { id: "ct_new" } };
    return { data: { imessage: true } };
  };
  const result = await TOOLS_BY_NAME.get("contact_capabilities").run(
    { contact: "+15551234567" },
    send,
  );
  assert.deepEqual(result, { data: { imessage: true } });
  assert.deepEqual(requests, [
    "GET /contacts?identifier=%2B15551234567&limit=1",
    "POST /contacts",
    "GET /contacts/ct_new/capabilities",
  ]);
});
