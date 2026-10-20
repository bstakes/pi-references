import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acceptsExtension, loadSettings, parseSettings } from "../src/config.ts";

test("defaults need no config and all filters/openers are optional", () => {
  const defaults = parseSettings({});
  assert.deepEqual(defaults.sources, { assistant: true, toolOutput: false, writes: false });
  assert.equal(defaults.defaultOpener, "auto");
  assert.equal(defaults.showMissing, false);
  assert.equal(acceptsExtension("/tmp/plan.md", defaults), true);
  assert.equal(acceptsExtension("/tmp/source.ts", defaults), true);
});

test("configuration overrides only specified fields and normalizes suffix case", () => {
  const settings = parseSettings({ sources: { toolOutput: true }, includeExtensions: [".MD", ".tar.gz"], excludeExtensions: [".draft.md"], openers: { ".MD": ["cmux", "markdown", "open", "{path}"] } });
  assert.equal(settings.sources.assistant, true);
  assert.equal(settings.sources.toolOutput, true);
  assert.equal(acceptsExtension("plan.MD", settings), true);
  assert.equal(acceptsExtension("plan.draft.md", settings), false);
  assert.equal(acceptsExtension("source.ts", settings), false);
  assert.deepEqual(settings.openers?.[".md"], ["cmux", "markdown", "open", "{path}"]);
});

test("malformed config cannot quietly select executable commands", () => {
  for (const value of [null, [], { typo: true }, { sources: { bad: true } }, { sources: { assistant: "yes" } }, { showMissing: 1 }, { includeExtensions: "md" }, { excludeExtensions: ["*"] }, { defaultOpener: "open {path}" }, { defaultOpener: [] }, { openers: { ".md": "sh -c something" } }, { openers: { "md": ["open"] } }, { openers: { ".md": [""] } }, { openers: { ".md": ["open", "\0"] } }]) {
    assert.throws(() => parseSettings(value));
  }
});

test("missing personal config is fine; malformed JSON is reported", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "attachment-browser.json");
  assert.deepEqual(await loadSettings(path), parseSettings({}));
  await writeFile(path, "not JSON");
  await assert.rejects(loadSettings(path));
  await writeFile(path, '{"sources":{"writes":true}}');
  assert.equal((await loadSettings(path)).sources.writes, true);
});
