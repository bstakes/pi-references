import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { openFile, resolveOpenCommand } from '../src/open.ts';
import type { OpenCommand, OpenSettings } from '../src/open.ts';

const linux = { platform: 'linux', env: {} } as const;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'attachment-open-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'space ; $(echo nope) & # %.md');
  await writeFile(path, 'fixture');
  return { path, directory };
}

test('system commands use absolute paths and preserve spaces/metacharacters as one argument', () => {
  const path = 'folder with spaces/-file;$(echo nope)&.md';
  const absolute = resolve(path);
  assert.deepEqual(resolveOpenCommand({ path }, {}, linux), { command: 'xdg-open', args: [absolute] });
  assert.deepEqual(resolveOpenCommand({ path }, { defaultOpener: 'system' }, {
    platform: 'darwin', env: { CMUX_WORKSPACE_ID: 'workspace' },
  }), { command: 'open', args: ['--', absolute] });
});

test('Windows uses a fixed script and passes the literal path only through the environment', () => {
  const path = resolve("evil ' ; $(whoami) &.txt");
  const result = resolveOpenCommand({ path }, {}, {
    platform: 'win32', env: { KEEP: 'yes', PI_ATTACHMENT_PATH: 'old' },
  });
  assert.deepEqual(result, {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Item -LiteralPath $env:PI_ATTACHMENT_PATH'],
    env: { KEEP: 'yes', PI_ATTACHMENT_PATH: path },
  });
  assert.ok(!result.args.some((arg) => arg.includes(path)));
});

test('auto selects cmux only when CMUX_WORKSPACE_ID exists', () => {
  const file = { path: 'a.md' };
  for (const env of [{}, { PATH: '/installed/cmux' }, { CMUX_WORKSPACE_ID: undefined }]) {
    assert.equal(resolveOpenCommand(file, {}, { platform: 'linux', env }).command, 'xdg-open');
  }
  for (const id of ['workspace', '']) {
    assert.deepEqual(resolveOpenCommand(file, {}, { platform: 'linux', env: { CMUX_WORKSPACE_ID: id } }), {
      command: 'cmux', args: ['open', resolve(file.path)],
    });
  }
});

test('extension matching is case insensitive, longest suffix wins, and wildcard precedes default', () => {
  const settings: OpenSettings = {
    defaultOpener: ['default'],
    openers: { '.GZ': ['gzip'], '.Tar.Gz': ['archive'], '.MD': ['markdown'], '*': ['fallback'] },
  };
  for (const [path, command] of [
    ['archive.TAR.GZ', 'archive'], ['archive.gz', 'gzip'], ['README.md', 'markdown'],
    ['unknown', 'fallback'], ['directory.md/file.txt', 'fallback'],
  ]) {
    assert.deepEqual(resolveOpenCommand({ path }, settings, linux), { command, args: [resolve(path)] });
  }
  assert.equal(resolveOpenCommand({ path: 'a.txt' }, { defaultOpener: ['default'] }, linux).command, 'default');
});

test('substitutes combined placeholders literally, including repeated tokens and encoded file URI', () => {
  const path = 'space ;$&/résumé #%.md';
  const result = resolveOpenCommand({ path, line: 12, column: 3 }, {
    defaultOpener: ['editor', '{path}:{line}:{column}', '{uri}', '{path}|{path}'],
  }, linux);
  assert.deepEqual(result, {
    command: 'editor',
    args: [`${resolve(path)}:12:3`, pathToFileURL(resolve(path)).href, `${resolve(path)}|${resolve(path)}`],
  });
  assert.match(result.args[1], /%20/);
  assert.match(result.args[1], /%23%25/);
  assert.ok(!result.args[1].includes('#'));
});

test('default location is 1:1 and URI has no invented line fragments', () => {
  const file = { path: 'a.md' };
  assert.deepEqual(resolveOpenCommand(file, { defaultOpener: ['editor', '{line}:{column}', '{uri}'] }, linux), {
    command: 'editor', args: ['1:1', pathToFileURL(resolve(file.path)).href],
  });
});

test('commands without placeholders append the path without interpreting shell syntax', () => {
  const command = ['editor with spaces', '--flag', 'literal; $(touch bad)', '{unknown}'];
  assert.deepEqual(resolveOpenCommand({ path: 'a.md' }, { defaultOpener: command }, linux), {
    command: command[0], args: [...command.slice(1), resolve('a.md')],
  });
  assert.deepEqual(command, ['editor with spaces', '--flag', 'literal; $(touch bad)', '{unknown}']);
});

test('rejects empty or malformed commands, including matched extension and wildcard entries', () => {
  for (const command of [[], [''], ['  '], [42], 'editor --flag']) {
    // Exercise runtime defensive handling beyond the public TypeScript contract.
    assert.throws(() => resolveOpenCommand({ path: 'a.md' }, {
      defaultOpener: command as OpenCommand,
    }, linux), /non-empty array/);
  }
  const invalidMappings: Record<string, OpenCommand>[] = [{ '.md': [] }, { '*': [] }];
  for (const openers of invalidMappings) {
    assert.throws(() => resolveOpenCommand({ path: 'a.md' }, { openers }, linux), /non-empty array/);
  }
});

test('unsupported platforms report a useful error unless a custom command is configured', () => {
  assert.throws(() => resolveOpenCommand({ path: 'a' }, {}, { platform: 'aix', env: {} }), /platform: aix/);
  assert.equal(resolveOpenCommand({ path: 'a' }, { defaultOpener: ['editor'] }, { platform: 'aix' }).command, 'editor');
});

test('validates missing files and directories before executing', async (t) => {
  const { path, directory } = await fixture(t);
  let executions = 0;
  const context = { ...linux, execute: async () => { executions++; } };
  await assert.rejects(openFile({ path: `${path}.missing` }, {}, context), /ENOENT/);
  await assert.rejects(openFile({ path: directory }, {}, context), /Not a regular file/);
  assert.equal(executions, 0);
});

test('rejects unreadable files before executing', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, async (t) => {
  const { path } = await fixture(t);
  await chmod(path, 0);
  try {
    await assert.rejects(openFile({ path }, {}, {
      ...linux, execute: async () => { assert.fail('must not execute'); },
    }), /EACCES|EPERM/);
  } finally {
    await chmod(path, 0o600);
  }
});

test('auto cmux success does not invoke a system opener', async (t) => {
  const { path } = await fixture(t);
  const calls: string[] = [];
  await openFile({ path }, {}, {
    ...linux, env: { CMUX_WORKSPACE_ID: 'workspace' },
    execute: async ({ command, args }) => { calls.push(command); assert.deepEqual(args, ['open', path]); },
  });
  assert.deepEqual(calls, ['cmux']);
});

test('auto falls back after cmux failure, and propagates system failure', async (t) => {
  const { path } = await fixture(t);
  for (const failSystem of [false, true]) {
    const calls: string[] = [];
    const failure = new Error('system failed');
    const result = openFile({ path }, {}, {
      ...linux, env: { CMUX_WORKSPACE_ID: 'workspace' },
      execute: async ({ command, args }) => {
        calls.push(command);
        if (command === 'cmux') throw new Error('cmux unavailable');
        assert.deepEqual(args, [path]);
        if (failSystem) throw failure;
      },
    });
    if (failSystem) await assert.rejects(result, (error) => error === failure);
    else await result;
    assert.deepEqual(calls, ['cmux', 'xdg-open']);
  }
});

test('explicit and extension commands never trigger auto fallback, even when named cmux', async (t) => {
  const { path } = await fixture(t);
  for (const settings of [
    { defaultOpener: 'system' as const },
    { defaultOpener: ['cmux'] },
    { openers: { '.md': ['cmux'] } },
  ]) {
    let calls = 0;
    const failure = new Error('opener failed');
    await assert.rejects(openFile({ path }, settings, {
      ...linux, env: { CMUX_WORKSPACE_ID: 'workspace' },
      execute: async () => { calls++; throw failure; },
    }), (error) => error === failure);
    assert.equal(calls, 1);
  }
});

test('real execution preserves argv literally without shell interpretation', async (t) => {
  const { path } = await fixture(t);
  await openFile({ path }, {
    defaultOpener: [process.execPath, '-e',
      'require("node:assert/strict").equal(process.argv[1], process.argv[2])', '--', path, '{path}'],
  });
});

test('real execution reports nonzero exit and missing executable errors', async (t) => {
  const { path, directory } = await fixture(t);
  await assert.rejects(openFile({ path }, {
    defaultOpener: [process.execPath, '-e', 'process.exit(7)', '--', '{path}'],
  }), /exit code 7/);
  await assert.rejects(openFile({ path }, { defaultOpener: [join(directory, 'missing-opener')] }), /ENOENT/);
});
