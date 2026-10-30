// MCP protocol handlers (tools, resources, prompts) and the upstream sender.
import { TOOLS, TOOLS_BY_NAME, ToolInputError } from "./tools.js";

/** A non-2xx response from the Blooio API. */
export class UpstreamError extends Error {
  constructor(status, body) {
    super(`${status} ${body}`);
    this.status = status;
  }
}

async function downloadFile(field, url) {
  if (typeof url !== "string" || !URL.canParse(url)) {
    throw new ToolInputError(`${field} must be a public URL.`);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new ToolInputError(`Could not download ${field} from ${url}: HTTP ${res.status}.`);
  }
  const filename = new URL(url).pathname.split("/").pop() || field;
  return { blob: await res.blob(), filename };
}

async function multipartBody(fields, fileFields) {
  const form = new FormData();
  for (const [field, value] of Object.entries(fields)) {
    if (fileFields.includes(field)) {
      const { blob, filename } = await downloadFile(field, value);
      form.append(field, blob, filename);
    } else {
      form.append(field, String(value));
    }
  }
  return form;
}

/**
 * A sender bound to the caller's upstream auth headers: performs a request
 * built by ./tools.js and returns the parsed body, throwing UpstreamError on
 * non-2xx.
 */
export function createSender(env, authHeaders) {
  return async (req) => {
    const headers = { ...authHeaders, ...req.headers };
    let body;
    if (req.bodyType === "multipart") {
      body = await multipartBody(req.body, req.fileFields);
    } else if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }
    const res = await fetch(`${env.UPSTREAM_BASE_URL}${req.path}`, {
      method: req.method,
      headers,
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(res.status, text);
    if (!text) return {};
    const isJson = (res.headers.get("content-type") || "").includes("json");
    return isJson ? JSON.parse(text) : text;
  };
}

export function mcpToolsList() {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.annotations.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  };
}

export async function mcpCallTool(send, name, args) {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) throw new ToolInputError(`Unknown tool: ${name}`);
  return tool.run(args, send);
}

const RESOURCES = [
  {
    uri: "blooio://account/info",
    name: "Account Information",
    description: "Authenticated account, devices/numbers, and usage.",
    mimeType: "application/json",
    tool: "me",
  },
  {
    uri: "blooio://channels",
    name: "Channels",
    description:
      "Messaging channels available to send from (addresses, aliases, and channel ids).",
    mimeType: "application/json",
    tool: "list_channels",
  },
  {
    uri: "blooio://webhooks",
    name: "Webhook Subscriptions",
    description: "Configured webhook subscriptions for inbound + delivery events.",
    mimeType: "application/json",
    tool: "list_webhooks",
  },
];

export function mcpResourcesList() {
  return { resources: RESOURCES.map(({ tool, ...resource }) => resource) };
}

export async function mcpReadResource(send, uri) {
  const resource = RESOURCES.find((r) => r.uri === uri);
  if (!resource) throw new ToolInputError(`Unknown resource URI: ${uri}`);
  return mcpCallTool(send, resource.tool, {});
}

const SENDER_ARGUMENT = {
  name: "channel",
  description:
    "Sender: phone number, alias, or channel id (ch_...); omit to auto-select",
  required: false,
};

const PROMPTS = [
  {
    name: "send_quick_message",
    description: "Send a quick text message to someone on a channel",
    arguments: [
      {
        name: "recipient",
        description: "Phone number (E.164 like +15551234567) or email address",
        required: true,
      },
      { name: "message", description: "The message text to send", required: true },
      SENDER_ARGUMENT,
    ],
    build: (a) => ({
      description: "Send a quick text message",
      text: `Send a text message to ${a.recipient || "[recipient]"}${a.channel ? ` from ${a.channel}` : " (omit from for automatic routing, or use list_channels to pick a sender)"} with the content: "${a.message || "[message]"}"`,
    }),
  },
  {
    name: "check_delivery",
    description: "Check the delivery status of a sent message",
    arguments: [
      {
        name: "chatId",
        description: "The chat id (chat_...) the message belongs to",
        required: true,
      },
      {
        name: "messageId",
        description: "The message id (msg_...) returned from send_message",
        required: true,
      },
    ],
    build: (a) => ({
      description: "Check message delivery status",
      text: `Check the delivery status of message ${a.messageId || "[messageId]"} in chat ${a.chatId || "[chatId]"}`,
    }),
  },
  {
    name: "send_with_attachment",
    description: "Send a message with an image or file attachment",
    arguments: [
      { name: "recipient", description: "Phone (E.164) or email", required: true },
      { name: "message", description: "Optional caption text", required: false },
      {
        name: "attachment_url",
        description: "Public URL of the image, video, or file",
        required: true,
      },
      SENDER_ARGUMENT,
    ],
    build: (a) => ({
      description: "Send a message with an attachment",
      text: `Send a message to ${a.recipient || "[recipient]"}${a.message ? ` with the caption "${a.message}"` : ""} and attach the file from ${a.attachment_url || "[attachment_url]"}${a.channel ? ` using channel ${a.channel}` : ""}`,
    }),
  },
  {
    name: "verify_contact",
    description: "Check if a contact can receive iMessage, SMS, or RCS",
    arguments: [
      {
        name: "contact",
        description: "Phone number (E.164) or email address to check",
        required: true,
      },
    ],
    build: (a) => ({
      description: "Verify contact capabilities",
      text: `Check if ${a.contact || "[contact]"} can receive iMessage, SMS, or RCS`,
    }),
  },
  {
    name: "setup_webhook",
    description: "Configure a webhook URL to receive inbound messages and events",
    arguments: [
      {
        name: "webhook_url",
        description: "Your HTTPS endpoint URL to receive webhook events",
        required: true,
      },
    ],
    build: (a) => ({
      description: "Configure webhook endpoint",
      text: `Create a webhook pointing at ${a.webhook_url || "[webhook_url]"} to receive inbound messages and delivery events`,
    }),
  },
  {
    name: "start_group_chat",
    description: "Create a group chat with several people and send a message",
    arguments: [
      {
        name: "members",
        description: "Comma-separated phone numbers / emails for the group",
        required: true,
      },
      { name: "name", description: "Optional group name", required: false },
      { name: "message", description: "First message to send", required: false },
    ],
    build: (a) => ({
      description: "Start a group chat",
      text: `Create a group chat${a.name ? ` named "${a.name}"` : ""} with these members: ${a.members || "[members]"}${a.message ? `, then send: "${a.message}"` : ""}`,
    }),
  },
];

export function mcpPromptsList() {
  return { prompts: PROMPTS.map(({ build, ...prompt }) => prompt) };
}

export function mcpGetPrompt(name, args) {
  const prompt = PROMPTS.find((p) => p.name === name);
  if (!prompt) throw new ToolInputError(`Unknown prompt: ${name}`);
  const { description, text } = prompt.build(args || {});
  return {
    description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}
