import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import plugin from "../plugin/plugin.json" with { type: "json" };

const openai = plugin.extensions["com.openai"];

// The MCP connection belongs to the existing OpenAI app; a bundled mcp.json is rejected as an override,
// and plugin-level test_cases are rejected without one, so review cases are entered in the portal.
test("plugin declares no MCP server and no review test cases", async () => {
  await assert.rejects(access(new URL("../plugin/mcp.json", import.meta.url)));
  assert.equal(openai.review.test_cases, undefined);
});

// OpenAI's submission limits for the directory listing.
test("listing fields fit the directory limits", () => {
  const ui = openai.interface;
  assert.ok(ui.displayName.length <= 30);
  assert.ok(ui.shortDescription.length <= 30);
  assert.ok(ui.longDescription.length <= 4000);
  assert.ok(ui.defaultPrompt.length <= 3);
  for (const prompt of ui.defaultPrompt) assert.ok(prompt.length <= 128);
});

test("listing assets exist", async () => {
  const ui = openai.interface;
  for (const path of [ui.logo, ui.logoDark, ui.composerIcon, ui.composerIconDark]) {
    await access(new URL(`../plugin/${path}`, import.meta.url));
  }
});
