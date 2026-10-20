import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { extractReferences, mergeReferences, parseReference, type IndexedFile } from "../src/references.ts";

const cwd = resolve("/work/project");
const path = (name: string) => resolve(cwd, name);

test("finds a plan, a /tmp playbook, and source locations in a response", () => {
  const refs = extractReferences("Read [implementation plan](docs/plan.md), `/tmp/playbook.md`, and src/main.ts:12:3.", cwd);
  assert.deepEqual(refs, [
    { path: path("docs/plan.md"), label: "implementation plan" },
    { path: resolve("/tmp/playbook.md") },
    { path: path("src/main.ts"), line: 12, column: 3 },
  ]);
});

test("supports space-containing and encoded Markdown destinations and file URIs", () => {
  const uri = pathToFileURL(resolve("/tmp/report #1.pdf")).href;
  const refs = extractReferences(`[report](<${resolve("/tmp/my report.pdf")}>) [plan](docs/my%20plan.md "Title") <${uri}>`, cwd);
  assert.deepEqual(refs.map((ref) => ref.path), [resolve("/tmp/my report.pdf"), path("docs/my plan.md"), resolve("/tmp/report #1.pdf")]);
});

test("supports inline code paths with spaces", () => {
  assert.deepEqual(extractReferences("See `/tmp/implementation plan.md`.", cwd), [{ path: resolve("/tmp/implementation plan.md") }]);
});

test("supports reference links but does not index unused definitions or web link labels", () => {
  assert.deepEqual(extractReferences("Read [playbook][p] and [plan]. [src/fake.ts](https://example.com/src/no.ts)\n[p]: /tmp/playbook.md\n[plan]: docs/plan.md\n[unused]: docs/unused.md", cwd), [
    { path: resolve("/tmp/playbook.md"), label: "playbook" },
    { path: path("docs/plan.md"), label: "plan" },
  ]);
});

test("supports filename parentheses, dotfiles, home paths, and GitHub-style source ranges", () => {
  assert.deepEqual(extractReferences("[report](docs/report(v2).md) `.env` ~/plan.md src/main.ts#L10-L20", cwd), [
    { path: path("docs/report(v2).md"), label: "report" },
    { path: path(".env") },
    { path: resolve(homedir(), "plan.md") },
    { path: path("src/main.ts"), line: 10 },
  ]);
});

test("explicit links and inline paths can name extensionless files", () => {
  assert.deepEqual(extractReferences("[plan](plan) `notes` Makefile", cwd).map((ref) => ref.path), [path("plan"), path("notes"), path("Makefile")]);
});

test("ignores non-file schemes, remote file hosts, controls, directories, and prose", () => {
  for (const value of ["https://example.com/src/test.ts", "javascript:alert(1)", "file://server/share/file.md", "file:///tmp/%1btest.md", "/tmp/evil\x1b.md", "foo", "./", "../", "src/", "src/*.ts"]) {
    assert.equal(parseReference(value, cwd), undefined, value);
  }
});

test("deduplicates equivalent mentions within a message and retains source locations", () => {
  assert.deepEqual(extractReferences("[plan](./docs/plan.md) `docs/plan.md` src/a.ts:2 src/a.ts:2", cwd), [
    { path: path("docs/plan.md"), label: "plan" },
    { path: path("src/a.ts"), line: 2 },
  ]);
});

test("merging keeps one original path per file, sources and most recent order", () => {
  const index = new Map<string, IndexedFile>();
  mergeReferences(index, [{ path: path("a.ts"), line: 1 }, { path: path("plan.md") }], "assistant");
  mergeReferences(index, [{ path: path("a.ts"), line: 5 }], "toolOutput");
  assert.deepEqual([...index.keys()], [path("plan.md"), path("a.ts")]);
  assert.deepEqual(index.get(path("a.ts")), { path: path("a.ts"), line: 5, sources: ["assistant", "toolOutput"], mentions: 2 });
});
