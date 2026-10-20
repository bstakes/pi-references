import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ReferenceSource = "assistant" | "toolOutput" | "writes";

export interface FileReference {
  path: string;
  line?: number;
  column?: number;
  label?: string;
}

export interface IndexedFile extends FileReference {
  sources: ReferenceSource[];
  mentions: number;
}

/** Resolve a reference only. Never copy files, read contents, or follow web URLs. */
export function parseReference(raw: string, cwd: string, explicit = false): FileReference | undefined {
  let value = raw.trim().replace(/^<|>$/g, "");
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return;
  let line: number | undefined;
  let column: number | undefined;
  const location = value.match(/(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?)$/i);
  if (location) {
    line = Number(location[1] ?? location[3]);
    column = location[2] || location[4] ? Number(location[2] ?? location[4]) : undefined;
    value = value.slice(0, location.index);
  }
  if (value.startsWith("file:")) {
    try {
      const url = new URL(value);
      // Local files only. Don't turn remote file shares into local paths.
      if (url.hostname && url.hostname !== "localhost") return;
      url.hash = "";
      url.search = "";
      value = fileURLToPath(url);
    } catch {
      return;
    }
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return;
    // Markdown destinations commonly percent-encode spaces.
    try { value = decodeURIComponent(value); } catch { return; }
  }
  if (/[\x00-\x1f\x7f]/.test(value) || /[<>|*?]/.test(value)) return;
  // Directories and prose aren't useful attachments. Extensionless absolute
  // and slash-qualified paths are still allowed, and checked on disk later.
  if (!value || value.endsWith("/") || value.endsWith("\\")) return;
  if (!explicit && !/[\\/]/.test(value) && !/^\.[\w-]+$/.test(value) && !/\.[\p{L}\p{N}_-]+$/u.test(value) && !/^(?:Makefile|Dockerfile|Containerfile|Justfile|Procfile|LICENSE|README|CHANGELOG)$/i.test(value)) return;
  if (value === "." || value === "..") return;
  if (value.startsWith("~/")) value = resolve(homedir(), value.slice(2));
  const path = isAbsolute(value) ? value : resolve(cwd, value);
  return {
    path,
    ...(line && Number.isSafeInteger(line) ? { line } : {}),
    ...(column && Number.isSafeInteger(column) ? { column } : {}),
  };
}

/** Markdown links, reference-style links, inline code, and plain file paths. */
export function extractReferences(text: string, cwd: string): FileReference[] {
  const found: FileReference[] = [];
  const add = (raw: string, label?: string, explicit = false) => {
    const ref = parseReference(raw, cwd, explicit);
    if (ref) found.push({ ...ref, ...(label ? { label } : {}) });
  };
  const definitions = new Map<string, string>();
  let remaining = text.replace(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|(\S+))[^\n]*$/gm, (_all, id, angled, plain) => {
    definitions.set(id.trim().toLowerCase(), angled ?? plain);
    return "";
  });
  // A destination can contain balanced parentheses one level deep.
  remaining = remaining.replace(/!?\[([^\]\n]*)\]\(\s*(<[^>\n]+>|(?:[^\s()]|\([^()]*\))+)(?:\s+["'][^\n]*?["'])?\s*\)/g,
    (_all, label, target) => { add(target, label, true); return " "; });
  remaining = remaining.replace(/\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g, (all, label, id) => {
    const target = definitions.get((id || label).trim().toLowerCase());
    if (!target) return all;
    add(target, label, true);
    return " ";
  });
  remaining = remaining.replace(/(?<!`)`([^`\n]+)`(?!`)/g, (_all, code) => {
    // Treat an inline-code span as one path so a space-containing filename
    // cannot also produce unrelated partial filename entries.
    add(code, undefined, true);
    return " ";
  });
  remaining = remaining.replace(/<([^<>\n]+)>/g, (_all, target) => { add(target, undefined, true); return " "; });
  for (const token of remaining.split(/\s+/)) {
    const candidate = token.replace(/^[\[({"'`]+/, "").replace(/[\])},;.!?"'`]+$/, "");
    add(candidate);
  }
  const unique = new Map<string, FileReference>();
  for (const ref of found) {
    const key = `${ref.path}\0${ref.line ?? ""}\0${ref.column ?? ""}`;
    const previous = unique.get(key);
    unique.set(key, { ...previous, ...ref });
  }
  return [...unique.values()];
}

export function mergeReferences(
  index: Map<string, IndexedFile>, references: FileReference[], source: ReferenceSource,
): void {
  for (const ref of references) {
    const previous = index.get(ref.path);
    index.delete(ref.path); // Map iteration order follows the most recent mention.
    index.set(ref.path, {
      ...previous,
      ...ref,
      sources: [...new Set([...(previous?.sources ?? []), source])],
      mentions: (previous?.mentions ?? 0) + 1,
    });
  }
}
