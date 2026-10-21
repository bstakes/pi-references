import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import type { AvailableFile } from "../src/file-index.ts";
import { FilePicker, displayText, type PickerResult } from "../src/picker.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const files: AvailableFile[] = [
  { path: resolve("/project/src/index.ts"), line: 12, column: 3, sources: ["assistant"], mentions: 1, available: true },
  { path: resolve("/tmp/release notes.md"), label: "Deployment playbook", sources: ["assistant"], mentions: 1, available: true },
  { path: resolve("/project/docs/日本語.md"), sources: ["assistant"], mentions: 1, available: true },
];

test("picker fuzzy-matches paths and link titles, then opens the original file reference", () => {
  let result: PickerResult | undefined;
  const picker = new FilePicker(files, "/project", theme, () => 24, (value) => { result = value; });
  picker.focused = true;
  picker.handleInput("dplyplb");
  assert.ok(picker.render(100).some((line) => line.includes("1/3")));
  picker.handleInput("\r");
  assert.equal(result?.file.path, files[1].path);
  assert.equal(result?.action, "open");
});

test("typing a filename filters out matches found only in the shared project path", () => {
  const cwd = resolve("/Users/example/projects/playground/pi-references");
  const candidates: AvailableFile[] = ["src/config.ts", "src/picker.ts", "README.md", "package.json"].map((name) => ({
    path: resolve(cwd, name), sources: ["assistant"], mentions: 1, available: true,
  }));
  let result: PickerResult | undefined;
  const picker = new FilePicker(candidates, cwd, theme, () => 24, (value) => { result = value; });
  assert.ok(picker.render(120)[0].includes("4/4"));
  let previousCount = candidates.length;
  for (const character of "readme") {
    picker.handleInput(character);
    const count = Number(picker.render(120)[0].match(/· (\d+)\//)?.[1]);
    assert.ok(count <= previousCount, `typing ${character} should not add candidates`);
    previousCount = count;
  }
  assert.equal(previousCount, 1);
  assert.ok(picker.render(120)[0].includes("1/4"));
  picker.handleInput("\r");
  assert.equal(result?.file.path, resolve(cwd, "README.md"));
  for (const _character of "readme") picker.handleInput("\x7f");
  assert.ok(picker.render(120)[0].includes("4/4"));
});

test("ordinary filename searches ignore unrelated external temporary-directory names", () => {
  const candidates: AvailableFile[] = ["notes.md", "plan.md"].map((name) => ({
    path: resolve("/private/var/folders/readme-plan-cache/T/session", name), sources: ["assistant"], mentions: 1, available: true,
  }));
  let result: PickerResult | undefined;
  const picker = new FilePicker(candidates, "/project", theme, () => 24, (value) => { result = value; });
  for (const character of "plan") picker.handleInput(`\x1b[${character.codePointAt(0)}u`);
  assert.ok(picker.render(120)[0].includes("1/2"));
  picker.handleInput("\r");
  assert.equal(result?.file.path, candidates[1].path);
});

test("slash-qualified queries can still search the full external path", () => {
  const candidates: AvailableFile[] = ["session-one", "session-two"].map((dir) => ({
    path: resolve("/tmp", dir, "config.ts"), sources: ["assistant"], mentions: 1, available: true,
  }));
  let result: PickerResult | undefined;
  const picker = new FilePicker(candidates, "/project", theme, () => 24, (value) => { result = value; }, "session-two/config");
  assert.ok(picker.render(120)[0].includes("1/2"));
  picker.handleInput("\r");
  assert.equal(result?.file.path, candidates[1].path);
});

test("picker supports navigation, paste path, cancellation, and no-match input", () => {
  let result: PickerResult | undefined;
  let closed = false;
  const picker = new FilePicker(files, "/project", theme, () => 24, (value) => { closed = true; result = value; });
  picker.handleInput("\x1b[B");
  picker.handleInput("\x19");
  assert.equal(result?.file.path, files[1].path);
  assert.equal(result?.action, "paste");
  const noMatch = new FilePicker(files, "/project", theme, () => 24, () => { closed = true; }, "zzzzzz");
  closed = false;
  noMatch.handleInput("\r");
  assert.equal(closed, false);
  assert.ok(noMatch.render(80).some((line) => line.includes("No matching references")));
  noMatch.handleInput("\x1b");
  assert.equal(closed, true);
});

test("picker emits encoded native file hyperlinks and preserves displayed line locations", () => {
  const picker = new FilePicker(files, "/project", theme, () => 24, () => {});
  const rendered = picker.render(150).join("\n");
  assert.ok(rendered.includes("file:///tmp/release%20notes.md"));
  assert.ok(rendered.includes("src/index.ts:12:3"));
  assert.ok(rendered.includes("\x1b]8;;file:"));
  assert.equal(displayText("bad\x1b]52;clipboard\x07\nname"), "bad]52;clipboardname");
});

test("rendering fits narrow and wide terminals, Unicode, and resize", () => {
  let rows = 24;
  const picker = new FilePicker(files, "/project", theme, () => rows, () => {});
  for (const width of [1, 2, 8, 20, 60, 120]) {
    for (const line of picker.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${visibleWidth(line)}`);
  }
  rows = 12;
  picker.invalidate();
  assert.ok(picker.render(80).length <= rows);
});

test("configured selection keybindings still work through the search input", (t) => {
  const previous = getKeybindings();
  t.after(() => setKeybindings(previous));
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": ["ctrl+n"], "tui.select.confirm": ["ctrl+o"] });
  setKeybindings(keys);
  let result: PickerResult | undefined;
  const picker = new FilePicker(files, "/project", theme, () => 24, (value) => { result = value; }, "", keys);
  picker.handleInput("\x0e");
  picker.handleInput("\x0f");
  assert.equal(result?.file.path, files[1].path);
});

test("anchors in the same file have independent selection, links, and reply context", () => {
  const path = resolve("/project/README.md");
  const candidates: AvailableFile[] = [
    { path, fragment: "configuration", label: "Personal settings", context: "Customize the opener using Personal settings.", sources: ["assistant"], mentions: 1, available: true },
    { path, fragment: "installation", label: "Setup", context: "Install the package with Setup first.", sources: ["assistant"], mentions: 1, available: true },
  ];
  let rows = 24;
  let result: PickerResult | undefined;
  const picker = new FilePicker(candidates, "/project", theme, () => rows, (value) => { result = value; });
  let rendered = picker.render(160).join("\n");
  assert.ok(rendered.includes("README.md#configuration"));
  assert.ok(rendered.includes("README.md#installation"));
  assert.ok(rendered.includes("file:///project/README.md#configuration"));
  assert.ok(rendered.includes(candidates[0].context!));
  picker.handleInput("\x1b[B");
  rows = 12;
  picker.render(160); // Resize must preserve the selected anchor, not just its path.
  rendered = picker.render(160).join("\n");
  assert.ok(rendered.includes(candidates[1].context!));
  picker.handleInput("\r");
  assert.equal(result?.file.fragment, "installation");
  assert.equal(result?.file.context, candidates[1].context);
});

test("anchor names can narrow the fuzzy list without changing the file target", () => {
  const path = resolve("/project/README.md");
  const candidates: AvailableFile[] = ["configuration", "installation"].map((fragment) => ({ path, fragment, sources: ["assistant"], mentions: 1, available: true }));
  let result: PickerResult | undefined;
  const picker = new FilePicker(candidates, "/project", theme, () => 24, (value) => { result = value; });
  for (const char of "installation") picker.handleInput(char);
  assert.ok(picker.render(120)[0].includes("1/2"));
  picker.handleInput("\r");
  assert.equal(result?.file.fragment, "installation");
});
