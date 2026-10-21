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
  const root = await mkdtemp(join(tmpdir(), "pi-references-extension-"));
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
      setStatus: (key: string, text: string | undefined) => { assert.equal(key, "references"); status = text; },
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
  assert.deepEqual([...extension.commands.keys()], ["refs"], "registers /refs without a /files alias");
  const command = extension.commands.get("refs");
  assert.ok(command);
  assert.ok(command.description?.includes("/refs [query]"));
  assert.equal(extension.tools.size, 0, "doesn't add a model tool or require agent cooperation");

  await emit("session_start");
  assert.equal(status, "<dim>References 1 · /refs</dim>");
  await command.handler("pln", ctx);
  assert.equal(pasted, JSON.stringify(plan));
  assert.ok(rendered.includes("file://"));
  assert.ok(rendered.includes("implementation plan"));
  assert.ok(rendered.includes("References · 1/1"));

  const latest = response(`Source: ${code}:42`);
  entries.push(latest);
  await emit("message_end", { message: latest.message });
  await emit("agent_end");
  assert.equal(status, "<dim>References 2 · /refs</dim>");
  entries = entries.slice(0, 1);
  await emit("session_tree");
  assert.equal(status, "<dim>References 1 · /refs</dim>");

  await writeFile(join(root, "references.json"), '{"showStatus":false}');
  await emit("session_tree");
  assert.equal(status, undefined, "hides an existing status when disabled");
  await emit("agent_end");
  assert.equal(status, undefined, "agent runs keep the status hidden");
  await command.handler("pln", ctx);
  assert.equal(pickerCount, 2, "the picker still works with the status hidden");
  assert.equal(pasted, JSON.stringify(plan));
  assert.equal(status, undefined);
  await writeFile(join(root, "references.json"), '{"showStatus":true}');
  await emit("session_tree");
  assert.equal(status, "<dim>References 1 · /refs</dim>");
  await writeFile(join(root, "references.json"), '{"includeExtensions":[".pdf"]}');
  await command.handler("", ctx);
  assert.equal(pickerCount, 2);
  assert.equal(status, undefined, "no status when no files match");
  assert.ok(notices.at(-1)?.includes("No referenced files or web links match"));
  await writeFile(join(root, "references.json"), '{"defaultOpener":"invalid"}');
  await command.handler("", ctx);
  assert.equal(pickerCount, 2);
  assert.ok(notices.at(-1)?.startsWith("References: "));
  assert.ok(notices.at(-1)?.includes("references.json"));
  assert.ok(notices.at(-1)?.includes("defaultOpener"));
  await rm(join(root, "references.json"));

  entries.push(response(`Install with [setup](${plan}#installation).\nCustomize using [settings](${plan}#configuration) next.`));
  await command.handler("configuration", ctx);
  assert.equal(status, "<dim>References 3 · /refs</dim>");
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
  assert.equal(notices.at(-1), "/refs needs pi's interactive terminal UI.");


  ctx.mode = "tui";
  ctx.hasUI = true;
  const url = "https://docs.example.com/start.md?mode=dev#installation";
  entries = [response(`Read the [browser guide](${url}).`)];
  await emit("session_start");
  assert.equal(status, "<dim>References 1 · /refs</dim>", "web links are indexed by default");
  await command.handler("browser guide", ctx);
  assert.equal(pasted, JSON.stringify(url), "paste preserves the URL, query, and fragment");
  assert.ok(rendered.includes(url));
  assert.ok(rendered.includes("browser guide"));
  assert.equal(pickerCount, 4);

  await writeFile(join(root, "references.json"), '{"includeWebLinks":false}');
  await command.handler("", ctx);
  assert.equal(status, undefined);
  assert.equal(pickerCount, 4, "disabling web links takes effect on the next invocation");
  assert.ok(notices.at(-1)?.includes("No referenced files or web links match"));

  await writeFile(join(root, "references.json"), '{"includeWebLinks":true,"includeExtensions":[],"excludeExtensions":[".md"]}');
  await command.handler("example.com", ctx);
  assert.equal(status, "<dim>References 1 · /refs</dim>", "file extension filters do not exclude web links");
  assert.equal(pickerCount, 5);
  assert.equal(pasted, JSON.stringify(url));
  entries = [];
  await emit("session_tree");
  assert.equal(status, undefined, "web links follow the active branch");
  await emit("session_shutdown");
});
