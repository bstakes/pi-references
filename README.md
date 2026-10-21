# pi attachment browser

Fuzzy-find files the assistant references in your pi session. Plans, playbooks, images, source code, and `/tmp` outputs stay where they are. This extension keeps references, not copies.

Built-in cmux support needs no configuration. Inside a cmux workspace, Enter opens files with `cmux open`. In other terminals, it uses your operating system's default app. You can also configure custom openers, including terminal editors in cmux splits.

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

A dim `Files N · /files` status appears when the session has matching, readable references. It updates after each agent run. Set `"showStatus": false` in your personal configuration to hide it without disabling `/files`. N counts distinct targets, so two anchors in one file count separately. Existing custom pi selection keybindings work in the picker.

### What gets indexed

The default is files referenced in the assistant's visible text, not every file written during a run. It recognizes local Markdown links, reference-style links, inline-code paths, plain paths, and `file://` links. References can point outside the project, including `/tmp`. Heading fragments such as `README.md#optional-personal-configuration` remain attached to the reference while discovery checks the underlying file. Encode a literal `#` in a filename as `%23`. Source locations such as `src/main.ts:42:3` and `src/main.ts#L42-L50` retain their starting line and column.

Relative paths resolve against the session working directory. References with spaces work as Markdown destinations, encoded URLs, or inline-code paths. Different anchors and source locations have separate picker entries. Repeated mentions of the same target merge and retain the latest available reply excerpt and link title. The selected entry shows that excerpt below its full path and anchor. The picker never reads file contents, copies attachments, or rewrites the assistant's reply.

The index is derived from the active session branch. Resume, reload, fork, and tree navigation use that branch's transcript. Compaction does not require a second index file. Thinking blocks and user prompts are not indexed. Missing or unreadable files are hidden by default, and paths are checked again whenever you open the list.

### How opening works

Enter and hyperlink clicks use different opening mechanisms.

- **Enter** uses the extension's opener. By default, it detects cmux as described below. Outside cmux, it uses the OS file association through macOS `open`, Linux `xdg-open`, or Windows PowerShell.
- **Hyperlink clicks** follow standard OSC 8 links to `file://` URLs. Your terminal and operating system control what happens. The extension does not intercept Ctrl+click or install a URL handler. Opener settings affect Enter, not link clicks.

The default Enter opener passes references with fragments as anchored file URIs and other files as absolute paths. The extension checks that the underlying file is readable before launching an opener. The viewer must honor URI fragments to scroll to a heading. The extension does not render Markdown or inject scrolling scripts.

### Built-in cmux support

When `CMUX_WORKSPACE_ID` is present, the default opener uses `cmux open`. The `cmux` executable must be on pi's `PATH`. If that command fails, the extension falls back to the OS opener with the same target. Set `defaultOpener` to `"system"` to skip cmux detection.

This integration handles Enter without custom rules or scripts. Hyperlink clicks still follow cmux's own link handling and do not guarantee a new pane. To launch a specific editor or control split placement, see [Custom cmux openers](#custom-cmux-openers).

Heading navigation has a known limitation in cmux 0.65.2, commit `9d01f956c`. `cmux open` converts file URIs to bare paths and discards their fragments before opening Markdown previews. Its native Markdown CLI/socket API has no heading-target parameter. `cmux browser open` retains the fragment but displays raw Markdown, so it is not a heading-navigation workaround. See [cmux's file-URL conversion](https://github.com/manaflow-ai/cmux/blob/9d01f956c/Packages/macOS/CmuxTerminalCore/Sources/CmuxTerminalCore/PathResolution/TerminalPathResolver.swift#L222-L233).

## Optional personal configuration

No settings file is needed. To customize behavior, create `~/.pi/agent/attachment-browser.json`. If you use a custom pi agent directory, put it there instead. The extension reads this file on session start and each `/files` invocation. It does not load project-local executable settings.

For example, open JavaScript and TypeScript in VS Code while leaving other files on the built-in automatic opener:

```json
{
  "openers": [
    { "extensions": [".js", ".jsx", ".ts", ".tsx"], "command": ["code", "{path}"] }
  ]
}
```

### Filtering and sources

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

### Settings reference

| Setting | Default | Behavior |
| --- | --- | --- |
| `sources.assistant` | `true` | Paths in the assistant's text blocks. |
| `sources.toolOutput` | `false` | Paths in tool-result text, including failed results. Can be noisy. |
| `sources.writes` | `false` | Successful direct calls to `write`, `edit`, `readSeek_write_file`, and `readSeek_edit_text`. Includes modifications to existing files. |
| `includeExtensions` | Unset | Allow all suffixes. An explicit array limits them; `[]` includes none. |
| `excludeExtensions` | `[]` | Exclude matching suffixes, even if included above. |
| `showMissing` | `false` | Show unresolved or unreadable references with a warning. Opening still requires a readable regular file. |
| `showStatus` | `true` | Show the dim file-count status in Pi's footer. Set to `false` to hide it; `/files` still works. |
| `defaultOpener` | `"auto"` | `"auto"` detects cmux, otherwise uses the OS opener. `"system"` always uses the OS opener. A command array sets a custom default. |
| `openers` | `[]` | Rules with `extensions` and `command` arrays. Longest suffix wins, case-insensitively. `"*"` is the fallback. |

### Custom opener commands

Each opener rule shares one command across its extensions. Matching uses the filename, not parent directories. A matching suffix wins over `"*"`, then `defaultOpener` handles unmatched files. Rule order does not change priority. Duplicate suffixes, including case variants or multiple wildcards, are configuration errors. Extension arrays must be nonempty. There are no built-in file groups or content-based detection.

Commands are executable-and-argument arrays, not shell strings. If a command contains no placeholders, the extension appends the absolute file path.

Use `{uri}` to pass a heading fragment to a viewer, or `{fragment}` if your launcher handles headings itself. Commands using only `{path}` open without an anchor. Use `{line}` and `{column}` for source locations.

| Placeholder | Value |
| --- | --- |
| `{path}` | Absolute file path without a location suffix. |
| `{uri}` | File URI including the selected fragment, if present. Colon-style line locations do not invent a URI fragment. |
| `{fragment}` | Original fragment without `#`, retaining percent escapes; empty when absent. |
| `{line}` | Starting line number; empty when absent. |
| `{column}` | Starting column number; empty when absent, even if a line is present. |

An explicit `:1` produces `"1"`; a bare file produces `""`. Empty arguments are preserved, not removed. Launchers should check `{line}` first for a source location, otherwise `{fragment}` for a heading, otherwise open the plain file. A source fragment such as `#L42` supplies both fragment `"L42"` and line `"42"`. Heading names are not converted to line numbers. Apply viewer-specific defaults in your launcher rather than in the configuration template.

Use a launcher that opens a separate viewer and exits. Child processes have no interactive terminal input or output; a terminal editor such as `vim` is not suitable as a direct opener. A custom opener can execute code, so only add commands you trust. The extension does not run commands automatically when it sees a reference.

To use a browser, configure its launcher, for example `{ "extensions": [".html"], "command": ["open", "-a", "Firefox", "{uri}"] }` as an opener rule on macOS. There is no HTTP server. Files that depend on HTTP, module loading, or a web app runtime may need your own development server instead.

## Custom cmux openers

The [built-in cmux integration](#built-in-cmux-support) uses `cmux open`. The following setup is optional and replaces that behavior for selected file types with a Neovim split and an explicit Markdown viewer command.

### Opening source files in a cmux split

Use an executable wrapper for terminal editors. Do not launch an interactive shell to load aliases or functions. Shell startup adds latency and can trigger job control that suspends pi. For aliases that just invoke a command, configure that command directly.

Save this script as `cmux-nvim`:

```bash
#!/bin/bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo 'Usage: cmux-nvim FILE [LINE [COLUMN]]' >&2
  exit 2
fi
file=$1
line=${2:-}
column=${3:-}
for number in "$line" "$column"; do
  if [[ -n $number && ! $number =~ ^[1-9][0-9]*$ ]]; then
    echo 'Line and column must be positive integers or empty.' >&2
    exit 2
  fi
done
[[ $file == /* ]] || file="$PWD/$file"
if [[ ! -f $file || ! -r $file ]]; then
  printf 'Not a readable file: %s\n' "$file" >&2
  exit 1
fi
: "${CMUX_WORKSPACE_ID:?Run this inside a cmux workspace}"
: "${CMUX_SURFACE_ID:?Run this inside a cmux surface}"
nvim_bin=$(command -v nvim)
args=("$nvim_bin")
if [[ -n $line ]]; then
  args+=("+call cursor($line,${column:-1})")
fi
args+=(-- "$file")
printf -v editor_command '%q ' "${args[@]}"
printf -v command_text '/bin/bash -c %q' "exec $editor_command"
exec cmux new-split right \
  --workspace "$CMUX_WORKSPACE_ID" \
  --surface "$CMUX_SURFACE_ID" \
  --command "$command_text"
```

Install it on macOS:

```sh
sudo install -m 755 cmux-nvim /usr/local/bin/cmux-nvim
```

Both `cmux` and `nvim` must be on pi's `PATH`. The wrapper opens Neovim in a right split beside the calling surface. It jumps only when a line is present, using column 1 if none is supplied. Named headings open at the editor's normal position. The command arguments are quoted with Bash's `printf '%q'` and executed with noninteractive Bash, without loading shell startup files.

Configure `~/.pi/agent/attachment-browser.json`:

```json
{
  "defaultOpener": "auto",
  "openers": [
    {
      "extensions": [".ts", ".rs", ".cs", ".py"],
      "command": ["/usr/local/bin/cmux-nvim", "{path}", "{line}", "{column}"]
    },
    {
      "extensions": [".md"],
      "command": ["cmux", "markdown", "--focus", "true", "{path}"]
    }
  ]
}
```

Only the listed source extensions use Neovim. Markdown opens directly in cmux's formatted viewer; this command does not navigate to headings or source locations. Other files retain automatic opening. To use Neovim for every unmatched file instead, set `defaultOpener` to `["/usr/local/bin/cmux-nvim", "{path}", "{line}", "{column}"]`.

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
