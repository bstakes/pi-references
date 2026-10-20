import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, fuzzyFilter, getKeybindings, hyperlink, matchesKey, truncateToWidth, type Component, type Focusable, type KeybindingsManager } from "@earendil-works/pi-tui";
import { relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AvailableFile } from "./file-index.ts";

export interface PickerResult {
  file: AvailableFile;
  action: "open" | "paste";
}

/** Never let a filename or a model-provided label emit terminal controls. */
export function displayText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function location(file: AvailableFile): string {
  return file.line ? `:${file.line}${file.column ? `:${file.column}` : ""}` : "";
}

export class FilePicker implements Component, Focusable {
  private input = new Input({ prompt: "Find: ", placeholder: "path or link title" });
  private list!: SelectList;
  private filtered: AvailableFile[] = [];
  private files: AvailableFile[];
  private cwd: string;
  private theme: Theme;
  private rows: () => number;
  private done: (result: PickerResult | undefined) => void;
  private maxVisible = 0;
  private keys: Pick<KeybindingsManager, "matches">;

  constructor(files: AvailableFile[], cwd: string, theme: Theme, rows: () => number, done: (result: PickerResult | undefined) => void, query = "", keys: Pick<KeybindingsManager, "matches"> = getKeybindings()) {
    this.files = files;
    this.cwd = cwd;
    this.theme = theme;
    this.rows = rows;
    this.done = done;
    this.keys = keys;
    this.input.setValue(query);
    this.update();
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  private name(file: AvailableFile): string {
    const local = relative(this.cwd, file.path);
    const path = local && local !== ".." && !local.startsWith(`..${sep}`) ? local : file.path;
    return displayText(path + location(file));
  }

  private update(preserveSelection = false): void {
    const selected = preserveSelection ? this.list?.getSelectedItem()?.value : undefined;
    this.filtered = fuzzyFilter(this.files, this.input.getValue(), (file) => `${file.path} ${file.label ?? ""}`);
    this.maxVisible = Math.max(1, Math.min(12, this.rows() - 9));
    this.list = new SelectList(this.filtered.map((file) => ({
      value: file.path,
      label: hyperlink(this.name(file), pathToFileURL(file.path).href),
      description: displayText([file.available ? "" : "missing or unreadable", file.label, file.sources.join(", ")].filter(Boolean).join(" · ")),
    })), this.maxVisible, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: () => this.theme.fg("dim", "No matching files"),
    }, { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 72 });
    if (selected) this.list.setSelectedIndex(Math.max(0, this.filtered.findIndex((file) => file.path === selected)));
    this.list.onSelect = () => this.finish("open");
    this.list.onCancel = () => this.done(undefined);
  }

  private finish(action: PickerResult["action"]): void {
    const selected = this.list.getSelectedItem();
    const file = this.filtered.find((file) => file.path === selected?.value);
    if (file) this.done({ file, action });
  }

  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done(undefined);
    if (matchesKey(data, "ctrl+y")) return this.finish("paste");
    if ((["tui.select.up", "tui.select.down", "tui.select.confirm"] as const).some((key) => this.keys.matches(data, key))) {
      this.list.handleInput(data);
      return;
    }
    const previous = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== previous) this.update();
  }

  render(width: number): string[] {
    if (this.maxVisible !== Math.max(1, Math.min(12, this.rows() - 9))) this.update(true);
    const selected = this.filtered.find((file) => file.path === this.list.getSelectedItem()?.value);
    const lines = [
      this.theme.fg("accent", `Session files · ${this.filtered.length}/${this.files.length}`),
      ...this.input.render(Math.max(1, width)),
      "",
      ...this.list.render(Math.max(4, width)),
      "",
      selected ? hyperlink(displayText(selected.path + location(selected)), pathToFileURL(selected.path).href) : "",
      this.theme.fg("dim", "Enter open · Ctrl+Y paste path · Esc close · links use your terminal"),
    ];
    return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }
}
