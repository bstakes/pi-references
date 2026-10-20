import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { targetKey, targetSuffix, targetUri } from "../src/targets.ts";

test("different anchors and source locations have different stable reference identities", () => {
  const path = resolve("README.md");
  const targets = [{ path }, { path, fragment: "configuration" }, { path, fragment: "installation" }, { path, line: 42 }, { path, line: 42, column: 3 }];
  assert.equal(new Set(targets.map(targetKey)).size, targets.length);
  assert.equal(targetKey({ path: "./README.md", fragment: "configuration" }), targetKey(targets[1]));
});

test("URI construction keeps heading fragments separate from filename hashes", () => {
  const path = resolve("docs/plan #2.md");
  assert.equal(targetUri({ path, fragment: "configuration" }), `${pathToFileURL(path).href}#configuration`);
  assert.equal(targetUri({ path, fragment: "configuration%20examples" }), `${pathToFileURL(path).href}#configuration%20examples`);
  assert.equal(targetUri({ path }), pathToFileURL(path).href);
  assert.equal(targetSuffix({ path, fragment: "configuration" }), "#configuration");
  assert.equal(targetSuffix({ path, line: 42, column: 3 }), ":42:3");
});
