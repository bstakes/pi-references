import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadSettings, type Settings } from "./config.ts";
import { FileIndex } from "./file-index.ts";
import { openFile } from "./open.ts";
import { FilePicker, displayText, type PickerResult } from "./picker.ts";

export default function attachmentBrowser(pi: ExtensionAPI): void {
  const configPath = join(getAgentDir(), "attachment-browser.json");
  let state: { index: FileIndex; settings: Settings } | undefined;
  let generation = 0;

  const report = (ctx: ExtensionContext, error: unknown) => {
    if (ctx.hasUI) ctx.ui.notify(`Files: ${displayText(error instanceof Error ? error.message : String(error))}`, "error");
  };

  const updateStatus = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !state) return;
    const version = generation;
    const files = await state.index.available();
    if (version === generation) ctx.ui.setStatus("attachment-browser", files.length ? `Files ${files.length} · /files` : undefined);
  };

  const rebuild = async (ctx: ExtensionContext) => {
    const version = ++generation;
    state = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus("attachment-browser", undefined);
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
    if (ctx.mode === "tui") ctx.ui.setStatus("attachment-browser", undefined);
  });

  pi.registerCommand("files", {
    description: "Fuzzy-find and open files referenced in this session. /files [query]",
    handler: async (query, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("/files needs pi's interactive terminal UI.", "warning");
        return;
      }
      // Re-read personal settings and re-check paths each time. No watcher,
      // copied attachments, or agent participation is required.
      const current = await rebuild(ctx);
      if (!current) return;
      const files = await current.index.available();
      if (state !== current) return;
      if (!files.length) {
        ctx.ui.notify("No readable referenced files on this session branch. Missing /tmp files may have expired. Discovery settings live in " + configPath, "info");
        return;
      }
      const result = await ctx.ui.custom<PickerResult | undefined>((tui, theme, keys, done) =>
        new FilePicker(files, ctx.cwd, theme, () => tui.terminal.rows, done, query.trim(), keys),
      );
      if (!result || state !== current) return;
      if (result.action === "paste") {
        ctx.ui.pasteToEditor(JSON.stringify(result.file.path));
        return;
      }
      try {
        await openFile(result.file, current.settings);
      } catch (error) {
        report(ctx, error);
      }
    },
  });
}
