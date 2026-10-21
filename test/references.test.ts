import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { extractReferences, mergeReferences, parseReference, type IndexedFile } from "../src/references.ts";

const cwd = resolve("/work/project");
const path = (name: string) => resolve(cwd, name);

// Most assertions focus on target parsing; context excerpts are tested below.
const targetsIn = (text: string, cwd: string) => extractReferences(text, cwd).map(({ context: _context, ...ref }) => ref);

test("finds a plan, a /tmp playbook, and source locations in a response", () => {
  const refs = targetsIn("Read [implementation plan](docs/plan.md), `/tmp/playbook.md`, and src/main.ts:12:3.", cwd);
  assert.deepEqual(refs, [
    { path: path("docs/plan.md"), label: "implementation plan" },
    { path: resolve("/tmp/playbook.md") },
    { path: path("src/main.ts"), line: 12, column: 3 },
  ]);
});

test("supports space-containing and encoded Markdown destinations and file URIs", () => {
  const uri = pathToFileURL(resolve("/tmp/report #1.pdf")).href;
  const refs = targetsIn(`[report](<${resolve("/tmp/my report.pdf")}>) [plan](docs/my%20plan.md "Title") <${uri}>`, cwd);
  assert.deepEqual(refs.map((ref) => ref.path), [resolve("/tmp/my report.pdf"), path("docs/my plan.md"), resolve("/tmp/report #1.pdf")]);
});

test("heading fragments resolve to the underlying file across reference forms", () => {
  const target = "README.md#optional-personal-configuration";
  for (const text of [
    `[settings](${target})`,
    `See ${target}.`,
    `See \`${target}\`.`,
    `[settings][config]\n[config]: ${target}`,
    `<${pathToFileURL(path("README.md")).href}#optional-personal-configuration>`,
  ]) {
    const refs = targetsIn(text, cwd);
    assert.equal(refs.length, 1, text);
    assert.equal(refs[0].path, path("README.md"), text);
    assert.equal(refs[0].fragment, "optional-personal-configuration", text);
    assert.equal(refs[0].line, undefined, text);
    assert.equal(refs[0].column, undefined, text);
  }
});

test("heading text is not interpreted as source location or a standalone filename", () => {
  for (const fragment of ["settings:42", "settings:42:3", "settings#L42", ""]) {
    assert.deepEqual(parseReference(`README.md#${fragment}`, cwd), { path: path("README.md"), ...(fragment ? { fragment } : {}) });
  }
  assert.deepEqual(targetsIn("[settings](#optional-personal-configuration)", cwd), []);
});

test("literal encoded hashes survive fragment stripping and source line fragments still work", () => {
  assert.deepEqual(parseReference("docs/report%23v2.md#settings", cwd), { path: path("docs/report#v2.md"), fragment: "settings" });
  const uri = pathToFileURL(path("docs/report#v2.md")).href;
  assert.deepEqual(parseReference(`${uri}#settings`, cwd), { path: path("docs/report#v2.md"), fragment: "settings" });
  assert.deepEqual(parseReference("src/main.ts#L42C3-L50C8", cwd), { path: path("src/main.ts"), fragment: "L42C3-L50C8", line: 42, column: 3 });
  assert.deepEqual(parseReference(`${uri}#L42`, cwd), { path: path("docs/report#v2.md"), fragment: "L42", line: 42 });
  assert.deepEqual(parseReference("README.md", cwd), { path: path("README.md") });
});

test("supports inline code paths with spaces", () => {
  assert.deepEqual(targetsIn("See `/tmp/implementation plan.md`.", cwd), [{ path: resolve("/tmp/implementation plan.md") }]);
});

test("supports reference links but does not index unused definitions or link labels as files", () => {
  assert.deepEqual(targetsIn("Read [playbook][p] and [plan]. [src/fake.ts](https://example.com/src/no.ts)\n[p]: /tmp/playbook.md\n[plan]: docs/plan.md\n[unused]: docs/unused.md", cwd), [
    { kind: "web", path: "https://example.com/src/no.ts", label: "src/fake.ts" },
    { path: resolve("/tmp/playbook.md"), label: "playbook" },
    { path: path("docs/plan.md"), label: "plan" },
  ]);
});

test("supports filename parentheses, dotfiles, home paths, and GitHub-style source ranges", () => {
  assert.deepEqual(targetsIn("[report](docs/report(v2).md) `.env` ~/plan.md src/main.ts#L10-L20", cwd), [
    { path: path("docs/report(v2).md"), label: "report" },
    { path: path(".env") },
    { path: resolve(homedir(), "plan.md") },
    { path: path("src/main.ts"), fragment: "L10-L20", line: 10 },
  ]);
});

test("explicit links and inline paths can name extensionless files", () => {
  assert.deepEqual(targetsIn("[plan](plan) `notes` Makefile", cwd).map((ref) => ref.path), [path("plan"), path("notes"), path("Makefile")]);
});

test("ignores unsafe schemes, remote file hosts, controls, directories, and prose", () => {
  for (const value of ["javascript:alert(1)", "file://server/share/file.md", "file:///tmp/%1btest.md", "/tmp/evil\x1b.md", "foo", "./", "../", "src/", "src/*.ts"]) {
    assert.equal(parseReference(value, cwd), undefined, value);
  }
});

test("deduplicates equivalent mentions within a message and retains source locations", () => {
  assert.deepEqual(targetsIn("[plan](./docs/plan.md) `docs/plan.md` src/a.ts:2 src/a.ts:2", cwd), [
    { path: path("docs/plan.md"), label: "plan" },
    { path: path("src/a.ts"), line: 2 },
  ]);
});

test("merging keeps independent target locations and combines repeated exact references", () => {
  const index = new Map<string, IndexedFile>();
  mergeReferences(index, [{ path: path("a.ts"), line: 1 }, { path: path("plan.md") }], "assistant");
  mergeReferences(index, [{ path: path("a.ts"), line: 5 }], "toolOutput");
  mergeReferences(index, [{ path: path("a.ts"), line: 5 }], "assistant");
  assert.equal(index.size, 3);
  assert.deepEqual([...index.values()].map((ref) => [ref.path, ref.line]), [[path("a.ts"), 1], [path("plan.md"), undefined], [path("a.ts"), 5]]);
  assert.deepEqual([...index.values()].at(-1), { path: path("a.ts"), line: 5, sources: ["toolOutput", "assistant"], mentions: 2 });
});

test("separate anchors retain link labels and the surrounding reply context", () => {
  const refs = extractReferences("Install by reading [setup](README.md#installation) first.\nConfigure the viewer using [personal settings](README.md#configuration) next.", cwd);
  assert.deepEqual(refs.map(({ path: file, fragment, label, context }) => ({ file, fragment, label, context })), [
    { file: path("README.md"), fragment: "installation", label: "setup", context: "Install by reading setup first." },
    { file: path("README.md"), fragment: "configuration", label: "personal settings", context: "Configure the viewer using personal settings next." },
  ]);
});

test("web links work across Markdown, autolink, code, and plain URL forms", () => {
  const url = "https://Example.com/docs/report(v2)?q=a%20b&n=2#L42:3";
  for (const text of [`Read [guide](${url} "A title") now.`, `[guide][g]\n[g]: ${url} "Title"`, `<${url}>`, `\`${url}\``, `Read (${url}).`]) {
    const refs = extractReferences(text, cwd);
    assert.equal(refs.length, 1, text);
    assert.equal(refs[0].kind, "web", text);
    assert.equal(refs[0].path, url, text);
    assert.equal(refs[0].fragment, undefined);
    assert.equal(refs[0].line, undefined);
  }
  const ref = extractReferences(`Read [guide](${url} "A title") now.`, cwd)[0];
  assert.equal(ref.label, "guide");
  assert.equal(ref.context, "Read guide now.");
});

test("plain URL punctuation preserves balanced parentheses, query and hash", () => {
  for (const [text, url] of [
    ["https://example.com/a(b).", "https://example.com/a(b)"],
    ["(https://example.com/a(b(c))).", "https://example.com/a(b(c))"],
    ["https://example.com/a?x=1#part;", "https://example.com/a?x=1#part"],
    ["https://example.com/?", "https://example.com/?"],
  ]) assert.deepEqual(extractReferences(text, cwd).map((ref) => ref.path), [url]);
});

test("rejected or disabled URLs never yield filename substrings", () => {
  const text = '[src/fake.ts](https://example.com/a.ts) <https://example.com/b.ts> `https://example.com/c.ts` https://example.com/d.ts\n[x][r]\n[r]: https://example.com/e.ts';
  assert.deepEqual(extractReferences(text, cwd, false), []);
  for (const bad of ["[bad](https://bad host/file.md)", "[bad](javascript:alert(1))", "<https://bad host/file.md>", "https:///example.com/file.md", "[bad](ftp://example.com/file.md)"]) {
    assert.deepEqual(extractReferences(bad, cwd), [], bad);
  }
});
