import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface FileTarget {
  kind?: "file";
  path: string;
  /** URI fragment without the leading #. Existing percent escapes are retained. */
  fragment?: string;
  line?: number;
  column?: number;
}

export interface WebTarget {
  kind: "web";
  /** The full original URL, including query and hash. */
  path: string;
  fragment?: never;
  line?: never;
  column?: never;
}

export type ReferenceTarget = FileTarget | WebTarget;

/** Validate without normalizing the spelling or following the URL. */
export function parseWebReference(raw: string): WebTarget | undefined {
  if (!/^https?:\/\/[^/]/i.test(raw) || /[\s\x00-\x1f\x7f-\x9f\\]/u.test(raw) || /[<>"`]/.test(raw) || /%(?![\da-f]{2})/i.test(raw)) return;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || /^\.+$/.test(url.hostname)) return;
    return { kind: "web", path: raw };
  } catch {
    return;
  }
}

/** Different headings and source locations are independently selectable. */
export function targetKey(file: ReferenceTarget): string {
  if (file.kind === "web") return JSON.stringify(["web", file.path]);
  return JSON.stringify([resolve(file.path), file.fragment || null, file.line ?? null, file.column ?? null]);
}

export function targetUri(file: ReferenceTarget): string {
  if (file.kind === "web") return file.path;
  const url = pathToFileURL(resolve(file.path));
  if (file.fragment) url.hash = file.fragment;
  return url.href;
}

export function targetSuffix(file: ReferenceTarget): string {
  if (file.kind === "web") return "";
  if (file.fragment) return `#${file.fragment}`;
  return file.line ? `:${file.line}${file.column ? `:${file.column}` : ""}` : "";
}
