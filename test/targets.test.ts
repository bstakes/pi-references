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

test("web targets preserve literal URLs and have independent identities", async () => {
  const { parseWebReference } = await import("../src/targets.ts");
  for (const path of ["HTTPS://Example.COM:443/a%2fb?q=x#L42", "http://localhost:8080/a", "https://[::1]/"]) {
    const web = parseWebReference(path)!;
    assert.deepEqual(web, { kind: "web", path });
    assert.equal(targetUri(web), path);
    assert.equal(targetSuffix(web), "");
    assert.notEqual(targetKey(web), targetKey({ path }));
  }
  for (const raw of ["javascript:alert(1)", "data:text/plain,hello", "ftp://example.com/a", "//example.com/a", "https:example.com", "https:///example.com", "https://", "https://a:invalid/", "https://a b/c", "https://a/\nfile.md", " https://a/", "https://a/\\b", "https://a/%xx"]) {
    assert.equal(parseWebReference(raw), undefined, raw);
  }
});
