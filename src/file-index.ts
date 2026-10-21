import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { acceptsExtension, type Settings } from "./config.ts";
import { extractReferences, mergeReferences, type IndexedFile } from "./references.ts";

export type AvailableFile = IndexedFile & {
  available: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const pathTools = new Set(["write", "edit", "readSeek_write_file", "readSeek_edit_text"]);

/** Derived from the active transcript, not a second file store. */
export class FileIndex {
  private files = new Map<string, IndexedFile>();
  private calls = new Map<string, { name: string; path: string }>();
  private cwd: string;
  private settings: Settings;

  constructor(cwd: string, settings: Settings) {
    this.cwd = cwd;
    this.settings = settings;
  }

  ingest(message: unknown): void {
    if (!object(message)) return;
    const blocks = Array.isArray(message.content) ? message.content.filter(object) : [];
    if (message.role === "assistant") {
      if (this.settings.sources.assistant) {
        const text = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
        mergeReferences(this.files, extractReferences(text, this.cwd, this.settings.includeWebLinks), "assistant");
      }
      if (this.settings.sources.writes) {
        for (const block of blocks) {
          if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string" || !pathTools.has(block.name) || !object(block.arguments) || typeof block.arguments.path !== "string") continue;
          if (/^[a-z][a-z\d+.-]*:/i.test(block.arguments.path) && !/^[a-z]:[\\/]/i.test(block.arguments.path)) continue;
          this.calls.set(block.id, { name: block.name, path: block.arguments.path });
        }
      }
    } else if (message.role === "toolResult") {
      if (this.settings.sources.toolOutput) {
        const text = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
        mergeReferences(this.files, extractReferences(text, this.cwd, this.settings.includeWebLinks), "toolOutput");
      }
      if (typeof message.toolCallId === "string") {
        const call = this.calls.get(message.toolCallId);
        this.calls.delete(message.toolCallId);
        if (this.settings.sources.writes && call && message.isError === false && message.toolName === call.name) {
          // Tool inputs are paths, not prose. Don't strip #L or :12 from a
          // real filename supplied directly to a write tool.
          mergeReferences(this.files, [{ path: resolve(this.cwd, call.path) }], "writes");
        }
      }
    }
  }

  rebuild(entries: readonly unknown[]): void {
    this.files.clear();
    this.calls.clear();
    for (const entry of entries) {
      if (object(entry) && entry.type === "message") this.ingest(entry.message);
    }
  }

  values(): IndexedFile[] {
    return [...this.files.values()].reverse().filter((file) => file.kind === "web" ? this.settings.includeWebLinks : acceptsExtension(file.path, this.settings));
  }

  async available(): Promise<AvailableFile[]> {
    const files = this.values();
    const results: AvailableFile[] = [];
    // Bound parallel stat work rather than launch thousands of filesystem calls.
    for (let start = 0; start < files.length; start += 32) {
      const batch = await Promise.all(files.slice(start, start + 32).map(async (file) => {
        if (file.kind === "web") return { ...file, available: true };
        try {
          const info = await stat(file.path);
          if (!info.isFile()) return;
          await access(file.path, constants.R_OK);
          return { ...file, available: true };
        } catch {
          return this.settings.showMissing ? { ...file, available: false } : undefined;
        }
      }));
      for (const file of batch) if (file) results.push(file);
    }
    return results;
  }
}
