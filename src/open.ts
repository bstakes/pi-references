import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { targetUri } from './targets.ts';
import type { FileTarget } from './targets.ts';

export type FileLocation = FileTarget;
export type OpenCommand = string[];
export type OpenSettings = {
  defaultOpener?: 'auto' | 'system' | OpenCommand;
  openers?: Record<string, OpenCommand>;
};

type ResolvedCommand = { command: string; args: string[]; env?: NodeJS.ProcessEnv };
type Context = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv };
type ExecutionContext = Context & {
  /** Optional execution seam; the default spawns directly without a shell. */
  execute?: (command: ResolvedCommand) => Promise<void>;
};

function selectOpener(file: FileLocation, settings: OpenSettings): 'auto' | 'system' | OpenCommand {
  const name = basename(file.path).toLowerCase();
  let selected: OpenCommand | undefined;
  let longest = -1;
  for (const [extension, command] of Object.entries(settings.openers ?? {})) {
    if (extension.startsWith('.') && name.endsWith(extension.toLowerCase()) && extension.length > longest) {
      selected = command;
      longest = extension.length;
    }
  }
  return selected ?? settings.openers?.['*'] ?? settings.defaultOpener ?? 'auto';
}

function systemCommand(file: FileLocation, context: Context): ResolvedCommand {
  const path = file.fragment ? targetUri(file) : resolve(file.path);
  switch (context.platform ?? process.platform) {
    case 'darwin':
      return { command: 'open', args: ['--', path] };
    case 'linux':
      return { command: 'xdg-open', args: [path] };
    case 'win32':
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', file.fragment
          ? 'Start-Process -FilePath $env:PI_ATTACHMENT_URI'
          : 'Invoke-Item -LiteralPath $env:PI_ATTACHMENT_PATH'],
        env: { ...(context.env ?? process.env), [file.fragment ? 'PI_ATTACHMENT_URI' : 'PI_ATTACHMENT_PATH']: path },
      };
    default:
      throw new Error(`No system file opener for platform: ${context.platform ?? process.platform}`);
  }
}

function isAutoCmux(opener: 'auto' | 'system' | OpenCommand, context: Context): boolean {
  return opener === 'auto' && (context.env ?? process.env).CMUX_WORKSPACE_ID !== undefined;
}

function buildCommand(file: FileLocation, opener: 'auto' | 'system' | OpenCommand, context: Context): ResolvedCommand {
  const path = resolve(file.path);
  if (opener === 'auto' || opener === 'system') {
    return isAutoCmux(opener, context)
      ? { command: 'cmux', args: ['open', file.fragment ? targetUri(file) : path] }
      : systemCommand(file, context);
  }
  if (!Array.isArray(opener) || opener.length === 0 ||
      opener.some((part) => typeof part !== 'string') || !opener[0].trim()) {
    throw new Error('An opener must be a non-empty array of strings with a non-empty executable');
  }
  const replacements: Record<string, string> = {
    path,
    uri: targetUri(file),
    fragment: file.fragment ?? '',
    line: String(file.line ?? 1),
    column: String(file.column ?? 1),
  };
  let hasPlaceholder = false;
  const parts = opener.map((part) => part.replace(/\{(path|uri|fragment|line|column)\}/g, (_, key: string) => {
    hasPlaceholder = true;
    return replacements[key];
  }));
  const [command, ...args] = parts;
  // Custom commands opt into heading navigation with {uri}; otherwise retain the path contract.
  if (!hasPlaceholder) args.push(path);
  return { command, args };
}

export function resolveOpenCommand(
  file: FileLocation,
  settings: OpenSettings = {},
  context: Context = {},
): ResolvedCommand {
  return buildCommand(file, selectOpener(file, settings), context);
}

async function execute(command: ResolvedCommand): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      shell: false,
      stdio: 'ignore',
      env: command.env,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`File opener ${command.command} failed (${signal ? `signal ${signal}` : `exit code ${code}`})`));
    });
  });
}

export async function openFile(
  file: FileLocation,
  settings: OpenSettings = {},
  context: ExecutionContext = {},
): Promise<void> {
  const absoluteFile = { ...file, path: resolve(file.path) };
  if (!(await stat(absoluteFile.path)).isFile()) {
    throw new Error(`Not a regular file: ${absoluteFile.path}`);
  }
  await access(absoluteFile.path, constants.R_OK);
  const opener = selectOpener(absoluteFile, settings);
  const command = buildCommand(absoluteFile, opener, context);
  const run = context.execute ?? execute;
  try {
    await run(command);
  } catch (error) {
    if (!isAutoCmux(opener, context)) throw error;
    await run(systemCommand(absoluteFile, context));
  }
}
