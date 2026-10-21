import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseSettings } from "../src/config.ts";
import { FileIndex } from "../src/file-index.ts";

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const entry = (message: unknown) => ({ type: "message", message });

test("default discovery follows user-facing references, not users, thinking, or silent tool writes", () => {
  const index = new FileIndex("/project", parseSettings({}));
  index.rebuild([
    entry({ role: "user", content: [{ type: "text", text: "user.md" }] }),
    entry({ role: "assistant", content: [{ type: "thinking", thinking: "hidden.md" }, { type: "toolCall", id: "1", name: "write", arguments: { path: "silent.md" } }] }),
    entry({ role: "toolResult", toolCallId: "1", toolName: "write", isError: false, content: [{ type: "text", text: "tool.md" }] }),
    entry(assistant("[plan](plan.md) src/main.ts:42")),
  ]);
  assert.deepEqual(index.values().map((file) => file.path), [resolve("/project/src/main.ts"), resolve("/project/plan.md")]);
  assert.equal(index.values()[0].line, 42);
});

test("writes and tool outputs are independently configurable, failed writes are excluded", () => {
  const index = new FileIndex("/project", parseSettings({ sources: { assistant: false, writes: true, toolOutput: true } }));
  for (const [id, name, path, error] of [["1", "write", "silent.md", false], ["2", "edit", "failed.ts", true], ["3", "read", "read.md", false], ["4", "readSeek_write_file", "generated.svg", false]] as const) {
    index.ingest({ role: "assistant", content: [{ type: "text", text: "ignored.md" }, { type: "toolCall", id, name, arguments: { path } }] });
    index.ingest({ role: "toolResult", toolCallId: id, toolName: name, isError: error, content: [{ type: "text", text: "output.pdf" }] });
  }
  assert.deepEqual(index.values().map((file) => file.path).sort(), ["silent.md", "output.pdf", "generated.svg"].map((file) => resolve("/project", file)).sort());
});

test("rebuild follows just the current branch, and reconstructs identical live state", () => {
  const root = entry(assistant("plan.md"));
  const abandoned = entry(assistant("abandoned.md"));
  const current = entry(assistant("current.md"));
  const index = new FileIndex("/project", parseSettings({}));
  index.rebuild([root, abandoned]);
  index.rebuild([root]);
  index.ingest(current.message);
  const live = index.values();
  index.rebuild([root, current]);
  assert.deepEqual(index.values(), live);
  assert.equal(index.values().some((file) => file.path.endsWith("abandoned.md")), false);
  index.rebuild([]);
  assert.deepEqual(index.values(), []);
});

test("availability checks original external paths and never copies files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const external = join(root, "playbook.md");
  await writeFile(external, "plan");
  await mkdir(join(root, "folder.md"));
  const index = new FileIndex(join(root, "unrelated"), parseSettings({}));
  index.ingest(assistant(`Read [playbook](${external}), ${join(root, "missing.md")} and ${join(root, "folder.md")}`));
  assert.deepEqual((await index.available()).map((file) => [file.path, file.available]), [[external, true]]);
  await rm(external);
  assert.deepEqual(await index.available(), []);
});

test("an existing README linked with a heading fragment is not hidden as missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-heading-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const readme = join(root, "README.md");
  await writeFile(readme, "## Optional personal configuration\n");
  const index = new FileIndex(root, parseSettings({}));
  const response = entry(assistant("[settings](README.md#optional-personal-configuration)"));
  index.rebuild([response]);
  assert.deepEqual((await index.available()).map((file) => [file.path, file.available]), [[readme, true]]);
  index.ingest(assistant("[README](README.md)"));
  assert.deepEqual((await index.available()).map((file) => [file.path, file.fragment]), [[readme, undefined], [readme, "optional-personal-configuration"]]);
});

test("session rebuild preserves distinct anchors with context and deduplicates repeated targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-anchors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const readme = join(root, "README.md");
  await writeFile(readme, "# Readme\n## Installation\n## Configuration\n");
  const index = new FileIndex(root, parseSettings({}));
  index.rebuild([
    entry(assistant("Install with [setup](README.md#installation).")),
    entry(assistant("Customize with [settings](README.md#configuration).")),
    entry(assistant("Revisit [settings](README.md#configuration) before continuing.")),
  ]);
  const refs = await index.available();
  assert.equal(refs.length, 2);
  assert.deepEqual(refs.map((ref) => [ref.fragment, ref.mentions]), [["configuration", 2], ["installation", 1]]);
  assert.equal(refs[0].context, "Revisit settings before continuing.");
  assert.ok(refs.every((ref) => ref.path === readme && ref.available));
});

test("missing-file display and extension filters apply without a filesystem scan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const index = new FileIndex(root, parseSettings({ showMissing: true, includeExtensions: [".md", ".ts"], excludeExtensions: [".ts"] }));
  index.ingest(assistant("missing.md main.ts report.pdf"));
  assert.deepEqual((await index.available()).map((file) => [file.path, file.available]), [[join(root, "missing.md"), false]]);
});

test("web availability bypasses file filters and missing-file checks", async () => {
  const index = new FileIndex("/nonexistent", parseSettings({ includeExtensions: [], excludeExtensions: [".pdf"] }));
  index.ingest(assistant("[report](https://example.invalid/report.pdf) missing.md"));
  assert.deepEqual((await index.available()).map((ref) => [ref.kind, ref.path, ref.available]), [["web", "https://example.invalid/report.pdf", true]]);
  const disabled = new FileIndex("/project", parseSettings({ includeWebLinks: false, showMissing: true }));
  disabled.ingest(assistant("[src/a.ts](https://example.com/src/b.ts) https://example.com/c.md local.md"));
  assert.deepEqual(disabled.values().map((ref) => ref.path), [resolve("/project/local.md")]);
});

test("web grouping retains latest label/context, source switches, and active branch", () => {
  const url = "https://example.com/a?q=1#section";
  const root = entry(assistant(`Read [first](${url}) initially.`));
  const latest = entry(assistant(`Revisit [latest](${url}) now.`));
  const index = new FileIndex("/project", parseSettings({}));
  index.rebuild([root, entry(assistant("https://abandoned.invalid/")), latest]);
  index.rebuild([root, latest]);
  assert.equal(index.values().length, 1);
  assert.equal(index.values()[0].mentions, 2);
  assert.equal(index.values()[0].label, "latest");
  assert.equal(index.values()[0].context, "Revisit latest now.");
  const live = index.values();
  index.rebuild([root]);
  index.ingest(latest.message);
  assert.deepEqual(index.values(), live);
  const tool = { role: "toolResult", content: [{ type: "text", text: url }] };
  const tools = new FileIndex("/project", parseSettings({ sources: { assistant: false, toolOutput: true, writes: true } }));
  tools.ingest(root.message);
  assert.deepEqual(tools.values(), []);
  tools.ingest(tool);
  assert.deepEqual(tools.values()[0].sources, ["toolOutput"]);
  index.ingest(tool);
  assert.equal(index.values()[0].mentions, 2);
  tools.ingest({ role: "assistant", content: [{ type: "toolCall", id: "url", name: "write", arguments: { path: "https://write.invalid/a.md" } }] });
  tools.ingest({ role: "toolResult", toolCallId: "url", toolName: "write", isError: false, content: [] });
  assert.equal(tools.values().length, 1);
});
