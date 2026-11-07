import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import plugin from "../plugin/plugin.json" with { type: "json" };
import mcpConfig from "../plugin/mcp.json" with { type: "json" };
import serverJson from "../server.json" with { type: "json" };
import operations from "../src/operations.json" with { type: "json" };

const openai = plugin.extensions["com.openai"];
const toolNames = new Set(
  (operations.operations ?? operations).map((op) => op.name),
);

test("plugin points at the same MCP endpoint as the registry listing", () => {
  const servers = Object.values(mcpConfig.mcpServers);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].url, serverJson.remotes[0].url);
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

// Initial MCP review requires exactly five positive and three negative cases.
test("review test cases are complete and name real tools", () => {
  const { positive, negative } = openai.review.test_cases;
  assert.equal(positive.length, 5);
  assert.equal(negative.length, 3);
  for (const testCase of positive) {
    assert.ok(testCase.expected_behavior);
    for (const tool of testCase.tools_triggered.split(",")) {
      assert.ok(toolNames.has(tool.trim()), `unknown tool: ${tool.trim()}`);
    }
  }
});
