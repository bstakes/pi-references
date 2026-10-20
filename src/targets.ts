import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface FileTarget {
  path: string;
  /** URI fragment without the leading #. Existing percent escapes are retained. */
  fragment?: string;
  line?: number;
  column?: number;
}

/** Different headings and source locations are independently selectable. */
export function targetKey(file: FileTarget): string {
  return JSON.stringify([resolve(file.path), file.fragment || null, file.line ?? null, file.column ?? null]);
}

export function targetUri(file: Pick<FileTarget, "path" | "fragment">): string {
  const url = pathToFileURL(resolve(file.path));
  if (file.fragment) url.hash = file.fragment;
  return url.href;
}

export function targetSuffix(file: FileTarget): string {
  if (file.fragment) return `#${file.fragment}`;
  return file.line ? `:${file.line}${file.column ? `:${file.column}` : ""}` : "";
}
