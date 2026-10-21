import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadSettings, type Settings } from "./config.ts";
import { FileIndex } from "./file-index.ts";
import { openReference } from "./open.ts";
import { FilePicker, displayText, type PickerResult } from "./picker.ts";
import { targetSuffix, targetUri } from "./targets.ts";

export default function references(pi: ExtensionAPI): void {
  const configPath = join(getAgentDir(), "references.json");
  let state: { index: FileIndex; settings: Settings } | undefined;
  let generation = 0;

  const report = (ctx: ExtensionContext, error: unknown) => {
    if (ctx.hasUI) ctx.ui.notify(`References: ${displayText(error instanceof Error ? error.message : String(error))}`, "error");
  };

  const updateStatus = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !state) return;
    if (!state.settings.showStatus) {
      ctx.ui.setStatus("references", undefined);
      return;
    }
    const version = generation;
    const files = await state.index.available();
    if (version === generation) ctx.ui.setStatus("references", files.length ? ctx.ui.theme.fg("dim", `References ${files.length} · /refs`) : undefined);
  };

  const rebuild = async (ctx: ExtensionContext) => {
    const version = ++generation;
    state = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus("references", undefined);
    try {
      const settings = await loadSettings(configPath);
      const index = new FileIndex(ctx.cwd, settings);
      index.rebuild(ctx.sessionManager.getBranch());
      if (version !== generation) return;
      const next = { index, settings };
      state = next;
      await updateStatus(ctx);
      return version === generation ? next : undefined;
    } catch (error) {
      if (version === generation) report(ctx, new Error(`${configPath}: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  pi.on("session_start", async (_event, ctx) => { await rebuild(ctx); });
  pi.on("session_tree", async (_event, ctx) => { await rebuild(ctx); });
  pi.on("message_end", (event) => { state?.index.ingest(event.message); });
  pi.on("agent_end", async (_event, ctx) => { await updateStatus(ctx); });
  pi.on("session_shutdown", (_event, ctx) => {
    generation++;
    state = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus("references", undefined);
  });

  pi.registerCommand("refs", {
    description: "Fuzzy-find and open file and web references in this session. /refs [query]",
    handler: async (query, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("/refs needs pi's interactive terminal UI.", "warning");
        return;
      }
      // Re-read personal settings and re-check paths each time. No watcher,
      // copied attachments, or agent participation is required.
      const current = await rebuild(ctx);
      if (!current) return;
      const files = await current.index.available();
      if (state !== current) return;
      if (!files.length) {
        ctx.ui.notify("No referenced files or web links match on this session branch. Missing /tmp files may have expired. Discovery settings live in " + configPath, "info");
        return;
      }
      const result = await ctx.ui.custom<PickerResult | undefined>((tui, theme, keys, done) =>
        new FilePicker(files, ctx.cwd, theme, () => tui.terminal.rows, done, query.trim(), keys),
      );
      if (!result || state !== current) return;
      if (result.action === "paste") {
        const reference = result.file.kind === "web" || result.file.fragment ? targetUri(result.file) : result.file.path + targetSuffix(result.file);
        ctx.ui.pasteToEditor(JSON.stringify(reference));
        return;
      }
      try {
        await openReference(result.file, current.settings);
      } catch (error) {
        report(ctx, error);
      }
    },
  });
}
