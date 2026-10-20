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
  assert.ok(noMatch.render(80).some((line) => line.includes("No matching files")));
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
