# pi attachment browser

Fuzzy-find files the assistant references in your pi session. Plans, playbooks, images, source code, and `/tmp` outputs stay where they are. This extension keeps references, not copies.

## Try it

Requires pi 1.3.0 or later and Node.js 22.19 or later.

```sh
pi -e ./src/extension.ts
```

To load the package on future launches, run `pi install /absolute/path/to/pi-attachment-browser`. This changes your personal pi settings. Resume an existing session to browse its earlier references too.

## Use it

Run `/files`, or `/files playbook` to start with a search. The picker filters and ranks matches as you type. Ordinary queries search project-relative paths, external filenames, anchors, and Markdown link titles, without matching the shared project root or temporary-directory prefixes. Include a slash in the query to search full paths. Recent mentions appear first when the query is empty.

- Type to filter, then use Up/Down and Enter to open a file.
- Click a file hyperlink using your terminal's usual modifier, such as Ctrl+click or Cmd+click.
- Press Ctrl+Y to paste the selected reference into the pi prompt, quoted as a JSON string. Anchored references use a `file://` URI to retain the heading; source locations retain their line and column. This does not modify the system clipboard.
- Press Escape to close the list.

A `Files N · /files` status appears when the session has matching, readable references. It updates after each agent run. N counts distinct targets, so two anchors in one file count separately. Existing custom pi selection keybindings work in the picker.

### What gets indexed

The default is files referenced in the assistant's visible text, not every file written during a run. It recognizes local Markdown links, reference-style links, inline-code paths, plain paths, and `file://` links. References can point outside the project, including `/tmp`. Heading fragments such as `README.md#optional-personal-configuration` remain attached to the reference while discovery checks the underlying file. Encode a literal `#` in a filename as `%23`. Source locations such as `src/main.ts:42:3` and `src/main.ts#L42-L50` retain their starting line and column.

Relative paths resolve against the session working directory. References with spaces work as Markdown destinations, encoded URLs, or inline-code paths. Different anchors and source locations have separate picker entries. Repeated mentions of the same target merge and retain the latest available reply excerpt and link title. The selected entry shows that excerpt below its full path and anchor. The picker never reads file contents, copies attachments, or rewrites the assistant's reply.

The index is derived from the active session branch. Resume, reload, fork, and tree navigation use that branch's transcript. Compaction does not require a second index file. Thinking blocks and user prompts are not indexed. Missing or unreadable files are hidden by default, and paths are checked again whenever you open the list.

### How opening works

Native hyperlinks are standard OSC 8 links to `file://` URLs, including the selected reference's fragment. Your terminal and operating system control what a link click does. The extension does not intercept Ctrl+click or install a URL handler. A native link alone does not guarantee a new cmux pane.

Enter uses a separate opener. With no configuration, it uses `cmux open` when `CMUX_WORKSPACE_ID` is present, otherwise the OS file association through macOS `open`, Linux `xdg-open`, or Windows PowerShell. References with fragments are passed as anchored file URIs; other files use their absolute paths. If automatic cmux opening fails, the OS fallback receives the same target. Filesystem validation always checks the clean file path.

Preserving a heading target does not guarantee the viewer will scroll to it. The terminal, cmux preview, browser, or OS-associated app must honor file URI fragments. The extension does not render Markdown or inject scrolling scripts into viewers. Custom commands can use `{uri}` or `{fragment}`; commands using only `{path}` intentionally open the file without an anchor. Source locations are available through `{line}` and `{column}`. Set `defaultOpener` to `"system"` to skip cmux detection.

Known limitation in cmux 0.65.2, commit `9d01f956c`: `cmux open` converts file URIs to bare paths and discards their fragments before opening Markdown previews. Its native Markdown CLI/socket API has no heading-target parameter. `cmux browser open` retains the fragment but displays raw Markdown, so it is not a heading-navigation workaround. See [cmux's file-URL conversion](https://github.com/manaflow-ai/cmux/blob/9d01f956c/Packages/macOS/CmuxTerminalCore/Sources/CmuxTerminalCore/PathResolution/TerminalPathResolver.swift#L222-L233).

## Optional personal configuration

No settings file is needed. To customize behavior, create `~/.pi/agent/attachment-browser.json`. If you use a custom pi agent directory, put it there instead. The extension reads this file on session start and each `/files` invocation. It does not load project-local executable settings.

For example, open Markdown through cmux and TypeScript through VS Code:

```json
{
  "openers": {
    ".md": ["cmux", "open", "{uri}"],
    ".ts": ["code", "--goto", "{path}:{line}:{column}"]
  }
}
```

To limit the list to documents and images:

```json
{
  "includeExtensions": [".md", ".pdf", ".html", ".svg", ".png", ".jpg"]
}
```

To include paths mentioned in tool results and files written without an assistant reference:

```json
{
  "sources": {
    "assistant": true,
    "toolOutput": true,
    "writes": true
  },
  "excludeExtensions": [".lock", ".map"],
  "showMissing": false
}
```

| Setting | Default | Behavior |
| --- | --- | --- |
| `sources.assistant` | `true` | Paths in the assistant's text blocks. |
| `sources.toolOutput` | `false` | Paths in tool-result text, including failed results. Can be noisy. |
| `sources.writes` | `false` | Successful direct calls to `write`, `edit`, `readSeek_write_file`, and `readSeek_edit_text`. Includes modifications to existing files. |
| `includeExtensions` | Unset | Allow all suffixes. An explicit array limits them; `[]` includes none. |
| `excludeExtensions` | `[]` | Exclude matching suffixes, even if included above. |
| `showMissing` | `false` | Show unresolved or unreadable references with a warning. Opening still requires a readable regular file. |
| `defaultOpener` | `"auto"` | `"auto"`, `"system"`, or a command array. |
| `openers` | `{}` | Per-suffix command arrays. Longest suffix wins, case-insensitively. `"*"` is the fallback. |

Commands are executable-and-argument arrays, not shell strings. Supported placeholders are `{path}`, `{uri}`, `{fragment}`, `{line}`, and `{column}`. `{path}` is always the clean original file path. `{uri}` includes the selected heading or source fragment, if present. `{fragment}` is the fragment without the leading `#`, or an empty string. Line and column default to 1; heading names are not converted to line numbers. If a command contains no placeholders, the extension appends the absolute file path.

Use a launcher that opens a separate viewer and exits. Child processes have no interactive terminal input or output; a terminal editor such as `vim` is not suitable as a direct opener. A custom opener can execute code, so only add commands you trust. The extension does not run commands automatically when it sees a reference.

To use a browser, configure its launcher, for example `".html": ["open", "-a", "Firefox", "{uri}"]` on macOS. There is no HTTP server. Files that depend on HTTP, module loading, or a web app runtime may need your own development server instead.

## Limits

Discovery is text-based, not a complete Markdown parser. Unusual escaping, deeply nested link destinations, and paths embedded in arbitrary code or structured tool data may be missed. Web URLs and remote file shares are not attachments. This extension does not monitor the filesystem, infer shell redirection targets, discover unreferenced build outputs, or preserve deleted temporary files. Optional write tracking does not reconstruct tools nested inside another tool.

Under SSH, file paths refer to the machine running pi. The local terminal may not be able to open those paths. Use your terminal's remote-file handling or configure an appropriate opener.

The interactive picker requires pi's terminal UI. It does not open dialogs or launch files in print, JSON, or RPC modes.

## Development

```sh
npm install --ignore-scripts
npm test
npm run typecheck
npm pack --dry-run
```

Tests cover reference discovery, active-branch reconstruction, missing files, filters, fuzzy searching, terminal links, narrow rendering, custom selection bindings, opener selection, and safe argument passing. Tests do not launch desktop applications.

For a manual check, load the extension, ask pi to reference an existing Markdown file and a `/tmp` file, then run `/files`. Check both Enter and your terminal's link-click gesture. Repeat after resuming the session. Native cmux click behavior and desktop application opening require this manual check.
