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
  assert.deepEqual(defaults.openers, []);
  assert.equal(defaults.showMissing, false);
  assert.equal(defaults.showStatus, true);
  assert.equal(acceptsExtension("/tmp/plan.md", defaults), true);
  assert.equal(acceptsExtension("/tmp/source.ts", defaults), true);
});

test("configuration overrides only specified fields and normalizes suffix case", () => {
  const settings = parseSettings({ sources: { toolOutput: true }, includeExtensions: [".MD", ".tar.gz"], excludeExtensions: [".draft.md"], openers: [{ extensions: [".MD", ".TXT"], command: ["cmux", "open", "{uri}"] }] });
  assert.equal(settings.sources.assistant, true);
  assert.equal(settings.sources.toolOutput, true);
  assert.equal(acceptsExtension("plan.MD", settings), true);
  assert.equal(acceptsExtension("plan.draft.md", settings), false);
  assert.equal(acceptsExtension("source.ts", settings), false);
  assert.deepEqual(settings.openers, [{ extensions: [".md", ".txt"], command: ["cmux", "open", "{uri}"] }]);
});

test("showStatus accepts booleans and rejects other values", () => {
  assert.equal(parseSettings({ showStatus: false }).showStatus, false);
  assert.equal(parseSettings({ showStatus: true }).showStatus, true);
  for (const showStatus of [null, 0, 1, "false", [], {}]) {
    assert.throws(() => parseSettings({ showStatus }), /showStatus must be a boolean/);
  }
});

test("unknown settings report the references name", () => {
  assert.throws(() => parseSettings({ typo: true }), /Unknown references setting: typo/);
});
test("malformed config cannot quietly select executable commands", () => {
  for (const value of [
    null, [], { typo: true }, { sources: { bad: true } }, { sources: { assistant: "yes" } },
    { showMissing: 1 }, { includeExtensions: "md" }, { excludeExtensions: ["*"] },
    { defaultOpener: "open {path}" }, { defaultOpener: [] },
    { openers: { ".md": ["open"] } },
    ...[
      null, [], "open", {},
      { extensions: [".md"] }, { command: ["open"] },
      { extensions: ".md", command: ["open"] },
      { extensions: [], command: ["open"] },
      { extensions: ["md"], command: ["open"] },
      { extensions: [".md", 42], command: ["open"] },
      { extensions: [".md"], command: "open {path}" },
      { extensions: [".md"], command: [] },
      { extensions: [".md"], command: [""] },
      { extensions: [".md"], command: ["open", "\0"] },
      { extensions: [".md"], command: ["open"], typo: true },
    ].map((rule) => ({ openers: [rule] })),
  ]) {
    assert.throws(() => parseSettings(value), JSON.stringify(value));
  }
});

test("missing personal config is fine; malformed JSON is reported", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-references-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "references.json");
  assert.deepEqual(await loadSettings(path), parseSettings({}));
  await writeFile(path, "not JSON");
  await assert.rejects(loadSettings(path));
  await writeFile(path, '{"sources":{"writes":true}}');
  assert.equal((await loadSettings(path)).sources.writes, true);
});

test("opener rules allow grouped suffixes and a wildcard without mutating input", () => {
  const input = { openers: [
    { extensions: [".PDF", ".PNG"], command: ["open", "{uri}"] },
    { extensions: ["*"], command: ["editor", "{path}"] },
  ] };
  const snapshot = structuredClone(input);
  assert.deepEqual(parseSettings(input).openers, [
    { extensions: [".pdf", ".png"], command: ["open", "{uri}"] },
    { extensions: ["*"], command: ["editor", "{path}"] },
  ]);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(parseSettings({ openers: [] }).openers, []);
});

test("duplicate suffixes and wildcards are rejected case-insensitively", () => {
  for (const extensions of [[".md", ".MD"], ["*", "*"]]) {
    assert.throws(() => parseSettings({ openers: [{ extensions, command: ["open"] }] }), /Duplicate opener/);
    assert.throws(() => parseSettings({ openers: extensions.map((ext) => ({ extensions: [ext], command: ["open"] })) }), /Duplicate opener/);
  }
});
