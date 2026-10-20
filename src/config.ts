import { readFile } from "node:fs/promises";
import type { OpenSettings } from "./open.ts";
import type { ReferenceSource } from "./references.ts";

export interface Settings extends OpenSettings {
  sources: Record<ReferenceSource, boolean>;
  includeExtensions?: string[];
  excludeExtensions: string[];
  showMissing: boolean;
}

const defaults = (): Settings => ({
  sources: { assistant: true, toolOutput: false, writes: false },
  excludeExtensions: [],
  showMissing: false,
  defaultOpener: "auto",
  openers: {},
});

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function command(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((arg) => typeof arg === "string" && !arg.includes("\0")) && value[0].trim().length > 0;
}

function extensions(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((ext) => typeof ext === "string" && /^\.[\w.-]+$/.test(ext))) {
    throw new Error(`${name} must be an array of suffixes such as [".md", ".pdf"].`);
  }
  return value.map((ext) => ext.toLowerCase());
}

export function parseSettings(value: unknown): Settings {
  if (!object(value)) throw new Error("Settings must be a JSON object.");
  const settings = defaults();
  const known = new Set(["sources", "includeExtensions", "excludeExtensions", "showMissing", "defaultOpener", "openers"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new Error(`Unknown attachment-browser setting: ${key}`);
  }
  if (value.sources !== undefined) {
    if (!object(value.sources)) throw new Error("sources must be an object of booleans.");
    for (const [source, enabled] of Object.entries(value.sources)) {
      if (!Object.hasOwn(settings.sources, source) || typeof enabled !== "boolean") throw new Error(`Invalid source: ${source}`);
      settings.sources[source as ReferenceSource] = enabled;
    }
  }
  if (value.includeExtensions !== undefined) settings.includeExtensions = extensions(value.includeExtensions, "includeExtensions");
  if (value.excludeExtensions !== undefined) settings.excludeExtensions = extensions(value.excludeExtensions, "excludeExtensions");
  if (value.showMissing !== undefined) {
    if (typeof value.showMissing !== "boolean") throw new Error("showMissing must be a boolean.");
    settings.showMissing = value.showMissing;
  }
  if (value.defaultOpener !== undefined) {
    if (value.defaultOpener !== "auto" && value.defaultOpener !== "system" && !command(value.defaultOpener)) {
      throw new Error("defaultOpener must be auto, system, or a nonempty command array.");
    }
    settings.defaultOpener = value.defaultOpener;
  }
  if (value.openers !== undefined) {
    if (!object(value.openers)) throw new Error("openers must map file suffixes to command arrays.");
    settings.openers = {};
    for (const [ext, args] of Object.entries(value.openers)) {
      if ((ext !== "*" && !/^\.[\w.-]+$/.test(ext)) || !command(args)) throw new Error(`Invalid opener for ${ext}. Use a suffix and a nonempty command array.`);
      settings.openers[ext.toLowerCase()] = args;
    }
  }
  return settings;
}

/** Only personal configuration may select executable commands. */
export async function loadSettings(path: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults();
    throw error;
  }
  return parseSettings(JSON.parse(text));
}

export function acceptsExtension(path: string, settings: Settings): boolean {
  const name = path.toLowerCase();
  return !settings.excludeExtensions.some((ext) => name.endsWith(ext)) &&
    (settings.includeExtensions === undefined || settings.includeExtensions.some((ext) => name.endsWith(ext)));
}
