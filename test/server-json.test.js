import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../package.json" with { type: "json" };
import serverJson from "../server.json" with { type: "json" };

// The registry publishes server.json only when its version is new.
test("server.json version matches package.json", () => {
  assert.equal(serverJson.version, pkg.version);
});
