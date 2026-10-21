import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWebReference, targetKey, type ReferenceTarget } from "./targets.ts";

export type ReferenceSource = "assistant" | "toolOutput" | "writes";

export type FileReference = ReferenceTarget & {
  label?: string;
  /** A short excerpt from the reply that mentioned this target. */
  context?: string;
}

export type IndexedFile = FileReference & {
  sources: ReferenceSource[];
  mentions: number;
}

/** Resolve a reference only. Never copy files, read contents, or follow web URLs. */
export function parseReference(raw: string, cwd: string, explicit = false): FileReference | undefined {
  let value = raw.trim().replace(/^<|>$/g, "");
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return;
  const web = parseWebReference(value);
  if (web) return web;
  // Reject malformed web URLs before interpreting file locations/fragments.
  if (/^https?:/i.test(value)) return;
  // Separate URL fragments before decoding so heading anchors aren't treated
  // as filenames, while an encoded %23 remains a literal filename character.
  const fragmentIndex = value.indexOf("#");
  const fragment = fragmentIndex < 0 ? undefined : value.slice(fragmentIndex + 1);
  if (fragmentIndex >= 0) value = value.slice(0, fragmentIndex);
  if (!value) return;
  let line: number | undefined;
  let column: number | undefined;
  const pathLocation = value.match(/:(\d+)(?::(\d+))?$/);
  if (pathLocation) value = value.slice(0, pathLocation.index);
  const location = fragment?.match(/^L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i) ?? pathLocation;
  if (location) {
    line = Number(location[1]);
    column = location[2] ? Number(location[2]) : undefined;
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
    ...(fragment ? { fragment } : {}),
    ...(line && Number.isSafeInteger(line) ? { line } : {}),
    ...(column && Number.isSafeInteger(column) ? { column } : {}),
  };
}

/** Markdown links, reference-style links, inline code, plain paths, and web URLs. */
export function extractReferences(text: string, cwd: string, includeWebLinks = true): FileReference[] {
  const found: FileReference[] = [];
  const add = (raw: string, label: string | undefined, explicit: boolean, offset: number, length: number) => {
    const ref = parseReference(raw, cwd, explicit);
    if (!ref || (ref.kind === "web" && !includeWebLinks)) return;
    const start = Math.max(text.lastIndexOf("\n", offset - 1) + 1, offset - 80);
    const nextLine = text.indexOf("\n", offset + length);
    const end = Math.min(nextLine < 0 ? text.length : nextLine, offset + length + 100);
    const context = text.slice(start, end)
      .replace(/!?\[([^\]\n]*)\]\(\s*(<[^>\n]+>|(?:[^\s()]|\([^()]*\))+)(?:\s+["'][^\n]*?["'])?\s*\)/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1")
      .replace(/[\x00-\x1f\x7f-\x9f\s]+/g, " ").trim().slice(0, 240);
    found.push({ ...ref, ...(label ? { label } : {}), ...(context && context !== raw.trim() && context !== label ? { context } : {}) });
  };
  const mask = (value: string) => " ".repeat(value.length);
  const definitions = new Map<string, string>();
  let remaining = text.replace(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|(\S+))[^\n]*$/gm, (all, id, angled, plain) => {
    definitions.set(id.trim().toLowerCase(), angled ?? plain);
    return mask(all);
  });
  // Preserve offsets while masking matches so context always comes from the
  // original reply, not from text already rewritten by another parser pass.
  remaining = remaining.replace(/!?\[([^\]\n]*)\]\(\s*(<[^>\n]+>|(?:[^\s()]|\([^()]*\))+)(?:\s+["'][^\n]*?["'])?\s*\)/g,
    (all, label, target, offset) => { add(target, label, true, offset, all.length); return mask(all); });
  // Mask malformed destinations too: never mine filenames from a rejected URL.
  remaining = remaining.replace(/!?\[[^\]\n]*\]\([^\n]*?\)/g, (all) => mask(all));
  remaining = remaining.replace(/\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g, (all, label, id, offset) => {
    const target = definitions.get((id || label).trim().toLowerCase());
    if (!target) return all;
    add(target, label, true, offset, all.length);
    return mask(all);
  });
  remaining = remaining.replace(/(?<!`)`([^`\n]+)`(?!`)/g, (all, code, offset) => {
    add(code, undefined, true, offset, all.length);
    return mask(all);
  });
  remaining = remaining.replace(/<([^<>\n]+)>/g, (all, target, offset) => { add(target, undefined, true, offset, all.length); return mask(all); });
  for (const match of remaining.matchAll(/\S+/g)) {
    let candidate = match[0].replace(/^[\[({"'`]+/, "").replace(/[,;.!"'`]+$/, "");
    // Closing prose delimiters are removable only when they are unbalanced.
    while (/[\])}]$/.test(candidate)) {
      const close = candidate.at(-1)!;
      const open = ({ ")": "(", "]": "[", "}": "{" } as Record<string, string>)[close];
      if (candidate.split(close).length <= candidate.split(open).length) break;
      candidate = candidate.slice(0, -1).replace(/[,;.!"'`]+$/, "");
    }
    add(candidate, undefined, false, match.index, match[0].length);
  }
  const unique = new Map<string, FileReference>();
  for (const ref of found) {
    const key = targetKey(ref);
    const previous = unique.get(key);
    unique.set(key, { ...(previous?.label ? { label: previous.label } : {}), ...(previous?.context ? { context: previous.context } : {}), ...ref });
  }
  return [...unique.values()];
}

export function mergeReferences(
  index: Map<string, IndexedFile>, references: FileReference[], source: ReferenceSource,
): void {
  for (const ref of references) {
    const key = targetKey(ref);
    const previous = index.get(key);
    index.delete(key); // Iteration order follows the most recent mention.
    index.set(key, {
      ...(previous?.label ? { label: previous.label } : {}),
      ...(previous?.context ? { context: previous.context } : {}),
      ...ref,
      sources: [...new Set([...(previous?.sources ?? []), source])],
      mentions: (previous?.mentions ?? 0) + 1,
    });
  }
}
