import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { targetUri } from "../src/targets.ts";

// Load through pi itself, but supply a fake terminal. No model calls or desktop
// application launches are needed to exercise lifecycle and command behavior.
test("pi loads the extension, restores history, updates branches, and applies settings without opening apps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-extension-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const plan = join(root, "plan.md");
  const code = join(root, "main.ts");
  await writeFile(plan, "plan");
  await writeFile(code, "code");
  const response = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
  let entries = [response(`[implementation plan](${plan})`)];
  let status: string | undefined;
  let pasted: string | undefined;
  let pickerCount = 0;
  let rendered = "";
  const notices: string[] = [];
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: {
      setStatus: (_key: string, text: string | undefined) => { status = text; },
      theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
      notify: (text: string) => { notices.push(text); },
      pasteToEditor: (text: string) => { pasted = text; },
      custom: async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
        pickerCount++;
        let result: unknown;
        const picker = await factory({ terminal: { rows: 24 } } as TUI, { fg: (_color: string, text: string) => text } as Theme, getKeybindings() as Parameters<typeof factory>[2], (value) => { result = value; });
        rendered = picker.render(120).join("\n");
        picker.handleInput?.("\x19"); // Paste, never open a desktop application.
        return result;
      },
    },
  } as unknown as ExtensionCommandContext;
  const result = await loadExtensions([resolve("src/extension.ts")], root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  const emit = async (name: string, event = {}) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
  };
  const command = extension.commands.get("files");
  assert.ok(command);
  assert.equal(extension.tools.size, 0, "doesn't add a model tool or require agent cooperation");

  await emit("session_start");
  assert.equal(status, "<dim>Files 1 · /files</dim>");
  await command.handler("pln", ctx);
  assert.equal(pasted, JSON.stringify(plan));
  assert.ok(rendered.includes("file://"));
  assert.ok(rendered.includes("implementation plan"));

  const latest = response(`Source: ${code}:42`);
  entries.push(latest);
  await emit("message_end", { message: latest.message });
  await emit("agent_end");
  assert.equal(status, "<dim>Files 2 · /files</dim>");
  entries = entries.slice(0, 1);
  await emit("session_tree");
  assert.equal(status, "<dim>Files 1 · /files</dim>");

  await writeFile(join(root, "attachment-browser.json"), '{"showStatus":false}');
  await emit("session_tree");
  assert.equal(status, undefined, "hides an existing status when disabled");
  await emit("agent_end");
  assert.equal(status, undefined, "agent runs keep the status hidden");
  await command.handler("pln", ctx);
  assert.equal(pickerCount, 2, "the picker still works with the status hidden");
  assert.equal(pasted, JSON.stringify(plan));
  assert.equal(status, undefined);
  await writeFile(join(root, "attachment-browser.json"), '{"showStatus":true}');
  await emit("session_tree");
  assert.equal(status, "<dim>Files 1 · /files</dim>");
  await writeFile(join(root, "attachment-browser.json"), '{"includeExtensions":[".pdf"]}');
  await command.handler("", ctx);
  assert.equal(pickerCount, 2);
  assert.equal(status, undefined, "no status when no files match");
  assert.ok(notices.at(-1)?.includes("No readable referenced files"));
  await writeFile(join(root, "attachment-browser.json"), '{"defaultOpener":"invalid"}');
  await command.handler("", ctx);
  assert.equal(pickerCount, 2);
  assert.ok(notices.at(-1)?.includes("defaultOpener"));
  await rm(join(root, "attachment-browser.json"));

  entries.push(response(`Install with [setup](${plan}#installation).\nCustomize using [settings](${plan}#configuration) next.`));
  await command.handler("configuration", ctx);
  assert.equal(status, "<dim>Files 3 · /files</dim>");
  assert.equal(pasted, JSON.stringify(targetUri({ path: plan, fragment: "configuration" })));
  assert.ok(rendered.includes("#configuration"));
  assert.ok(rendered.includes("Customize using settings next."));

  await emit("session_shutdown");
  assert.equal(status, undefined);
  for (const mode of ["rpc", "json", "print"] as const) {
    ctx.mode = mode;
    ctx.hasUI = mode === "rpc";
    await command.handler("", ctx);
  }
  assert.equal(pickerCount, 3);
});
