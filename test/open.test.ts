import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { openFile, openReference, resolveOpenCommand } from '../src/open.ts';
import type { OpenCommand, OpenSettings } from '../src/open.ts';
import { parseReference } from '../src/references.ts';

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
    openers: [
      { extensions: ['.GZ'], command: ['gzip'] },
      { extensions: ['.Tar.Gz'], command: ['archive'] },
      { extensions: ['.MD', '.TXT'], command: ['text'] },
      { extensions: ['*'], command: ['fallback'] },
    ],
  };
  for (const [path, command] of [
    ['archive.TAR.GZ', 'archive'], ['archive.gz', 'gzip'], ['README.md', 'text'],
    ['unknown', 'fallback'], ['directory.md/file.txt', 'text'],
    ['directory.md/file.bin', 'fallback'],
  ]) {
    assert.deepEqual(resolveOpenCommand({ path }, settings, linux), { command, args: [resolve(path)] });
  }
  assert.equal(resolveOpenCommand({ path: 'a.txt' }, { defaultOpener: ['default'] }, linux).command, 'default');
});

test('grouped rules preserve suffix priority regardless of rule or extension order', () => {
  const openers = [
    { extensions: ['*', '.png'], command: ['fallback'] },
    { extensions: ['.gz', '.zip'], command: ['archive'] },
    { extensions: ['.tar.gz', '.tgz'], command: ['tar'] },
  ];
  const reversed = [...openers].reverse().map((rule) => ({ ...rule, extensions: [...rule.extensions].reverse() }));
  for (const rules of [openers, reversed]) {
    for (const [path, command] of [
      ['file.tar.gz', 'tar'], ['file.tgz', 'tar'], ['file.gz', 'archive'],
      ['file.ZIP', 'archive'], ['file.png', 'fallback'], ['unknown', 'fallback'],
    ]) {
      assert.deepEqual(resolveOpenCommand({ path }, { openers: rules, defaultOpener: ['default'] }, linux), {
        command, args: [resolve(path)],
      });
    }
  }
  assert.equal(resolveOpenCommand({ path: 'a.txt' }, { openers: [], defaultOpener: ['default'] }, linux).command, 'default');
  assert.equal(resolveOpenCommand({ path: 'a.txt' }, { openers: [] }, linux).command, 'xdg-open');
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

test('absent location placeholders are empty and URI has no invented line fragments', () => {
  const file = { path: 'a.md' };
  assert.deepEqual(resolveOpenCommand(file, { defaultOpener: ['editor', '{line}', '{column}', '{uri}'] }, linux), {
    command: 'editor', args: ['', '', pathToFileURL(resolve(file.path)).href],
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
  const invalidRules: NonNullable<OpenSettings['openers']>[] = [
    [{ extensions: ['.md'], command: [] }], [{ extensions: ['*'], command: [] }],
  ];
  for (const openers of invalidRules) {
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
    { openers: [{ extensions: ['.md'], command: ['cmux'] }] },
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

test('default openers preserve percent-encoded headings and encode hashes in filenames', () => {
  const file = { path: 'folder/a%23b#c.md', fragment: 'Heading%20one' };
  const uri = `${pathToFileURL(resolve(file.path)).href}#Heading%20one`;
  assert.match(uri, /a%2523b%23c\.md#Heading%20one$/);
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const context = { platform, env: { KEEP: 'yes' } };
    const expected = platform === 'win32' ? {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:PI_ATTACHMENT_URI'],
      env: { KEEP: 'yes', PI_ATTACHMENT_URI: uri },
    } : {
      command: platform === 'darwin' ? 'open' : 'xdg-open',
      args: platform === 'darwin' ? ['--', uri] : [uri],
    };
    assert.deepEqual(resolveOpenCommand(file, {}, context), expected);
    assert.deepEqual(resolveOpenCommand(file, { defaultOpener: 'system' }, {
      ...context, env: { KEEP: 'yes', CMUX_WORKSPACE_ID: 'workspace' },
    }), platform === 'win32' ? {
      ...expected, env: { KEEP: 'yes', CMUX_WORKSPACE_ID: 'workspace', PI_ATTACHMENT_URI: uri },
    } : expected);
    assert.deepEqual(resolveOpenCommand(file, {}, {
      ...context, env: { CMUX_WORKSPACE_ID: 'workspace' },
    }), { command: 'cmux', args: ['open', uri] });
  }
});

test('Windows heading script is fixed and the URI is only passed in the environment', () => {
  const file = { path: "evil ' ; $(whoami) &.md", fragment: "heading'; $(whoami)" };
  const result = resolveOpenCommand(file, {}, { platform: 'win32', env: { PI_ATTACHMENT_URI: 'old' } });
  const url = pathToFileURL(resolve(file.path));
  url.hash = file.fragment;
  assert.deepEqual(result.env, { PI_ATTACHMENT_URI: url.href });
  assert.equal(result.args.at(-1), 'Start-Process -FilePath $env:PI_ATTACHMENT_URI');
  assert.ok(!result.args.some((arg) => arg.includes(file.fragment) || arg.includes(file.path)));
});

test('custom placeholders distinguish clean paths, anchored URIs, and raw fragments', () => {
  const path = 'folder/a%23b#c.md';
  for (const fragment of [undefined, '', 'Heading%20one']) {
    const file = { path, fragment };
    const uri = `${pathToFileURL(resolve(path)).href}${fragment ? `#${fragment}` : ''}`;
    assert.deepEqual(resolveOpenCommand(file, {
      defaultOpener: ['editor', '{uri}', '{fragment}', '{path}', '{fragment}|{fragment}'],
    }, linux), {
      command: 'editor', args: [uri, fragment ?? '', resolve(path), `${fragment ?? ''}|${fragment ?? ''}`],
    });
    assert.deepEqual(resolveOpenCommand(file, { defaultOpener: ['editor', '--flag'] }, linux), {
      command: 'editor', args: ['--flag', resolve(path)],
    });
    if (!fragment) {
      assert.deepEqual(resolveOpenCommand(file, {}, linux), { command: 'xdg-open', args: [resolve(path)] });
    }
  }
});

test('heading execution validates the clean file and preserves the URI through every system fallback', async (t) => {
  const { path, directory } = await fixture(t);
  const file = { path, fragment: 'Heading%20one' };
  const uri = `${pathToFileURL(path).href}#Heading%20one`;
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const env = { CMUX_WORKSPACE_ID: 'workspace' };
    const calls: ReturnType<typeof resolveOpenCommand>[] = [];
    await openFile(file, {}, {
      platform, env,
      execute: async (command) => {
        calls.push(command);
        if (command.command === 'cmux') throw new Error('cmux unavailable');
      },
    });
    assert.deepEqual(calls, [
      { command: 'cmux', args: ['open', uri] },
      resolveOpenCommand(file, { defaultOpener: 'system' }, { platform, env }),
    ]);
    const systemCalls: ReturnType<typeof resolveOpenCommand>[] = [];
    await openFile(file, { defaultOpener: 'system' }, {
      platform, env, execute: async (command) => { systemCalls.push(command); },
    });
    assert.deepEqual(systemCalls, [calls[1]]);
  }
  let executions = 0;
  const context = { ...linux, execute: async () => { executions++; } };
  await assert.rejects(openFile({ ...file, path: `${path}.missing` }, {}, context), /ENOENT/);
  await assert.rejects(openFile({ ...file, path: directory }, {}, context), /Not a regular file/);
  assert.equal(executions, 0);
  await openFile(file, {}, {
    ...linux, env: { CMUX_WORKSPACE_ID: 'workspace' },
    execute: async (command) => { assert.deepEqual(command, { command: 'cmux', args: ['open', uri] }); },
  });
});

test('location placeholders distinguish bare files, headings, explicit line one, and source fragments', () => {
  const path = 'folder/space " ; $(echo nope) {line} #%.md';
  const cases = [
    ['a.md', '', '', ''],
    ['a.md:1', '1', '', ''],
    ['a.md:1:1', '1', '1', ''],
    ['a.md:42:3', '42', '3', ''],
    ['a.md#Heading%20one', '', '', 'Heading%20one'],
    ['a.md#L42', '42', '', 'L42'],
    ['a.md#L42C3-L50', '42', '3', 'L42C3-L50'],
    ['a.md:12#installation', '12', '', 'installation'],
  ];
  for (const [reference, line, column, fragment] of cases) {
    const parsed = parseReference(reference, process.cwd(), true);
    assert.ok(parsed);
    const result = resolveOpenCommand({ ...parsed, path }, {
      defaultOpener: ['launcher', '{path}', '{line}', '{column}', '{fragment}', '{line}|{line}'],
    }, linux);
    assert.deepEqual(result, {
      command: 'launcher', args: [resolve(path), line, column, fragment, `${line}|${line}`],
    }, reference);
  }
});

test('real execution preserves absent locations as empty arguments rather than dropping them', async (t) => {
  const { path } = await fixture(t);
  await openFile({ path, fragment: 'Heading%20one' }, {
    defaultOpener: [process.execPath, '-e',
      'require("node:assert/strict").deepEqual(process.argv.slice(1), [process.argv[1], "", "", "Heading%20one"])',
      '--', '{path}', '{line}', '{column}', '{fragment}'],
  });
});


test('web links use the system browser on every platform and bypass file opener rules and cmux', async () => {
  const target = { kind: 'web', path: "https://example.com/notes.md?q=a%20b&literal=';$()%23#Heading%20one" } as const;
  const settings: OpenSettings = {
    defaultOpener: ['editor', '{path}'],
    openers: [{ extensions: ['.md', '*'], command: ['other-editor'] }],
  };
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const context = { platform, env: { KEEP: 'yes', CMUX_WORKSPACE_ID: 'workspace' } };
    const expected = platform === 'win32' ? {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:PI_ATTACHMENT_URI'],
      env: { ...context.env, PI_ATTACHMENT_URI: target.path },
    } : {
      command: platform === 'darwin' ? 'open' : 'xdg-open',
      args: platform === 'darwin' ? ['--', target.path] : [target.path],
    };
    assert.deepEqual(resolveOpenCommand(target, settings, context), expected);
    const calls: unknown[] = [];
    // An HTTP URL is not a local file. Success here also exercises bypassing stat/access.
    await openReference(target, settings, { ...context, execute: async (command) => { calls.push(command); } });
    assert.deepEqual(calls, [expected]);
  }
});

test('web opening rejects unsafe schemes and malformed URLs before executing', async () => {
  let executions = 0;
  for (const path of ['javascript:alert(1)', 'data:text/html,no', 'file:///tmp/a.md', 'ftp://example.com', 'https://', 'https://example.com/\u001b]8;;bad', 'https://example.com/a b']) {
    const target = { kind: 'web', path } as const;
    assert.throws(() => resolveOpenCommand(target, {}, linux), /HTTP and HTTPS/);
    await assert.rejects(openReference(target, {}, { ...linux, execute: async () => { executions++; } }), /HTTP and HTTPS/);
  }
  assert.equal(executions, 0);
});

test('web opener errors propagate without cmux fallback and unsupported platforms are reported', async () => {
  const target = { kind: 'web', path: 'https://example.com/' } as const;
  const failure = new Error('browser failed');
  let calls = 0;
  await assert.rejects(openReference(target, {}, {
    ...linux, env: { CMUX_WORKSPACE_ID: 'workspace' },
    execute: async () => { calls++; throw failure; },
  }), (error) => error === failure);
  assert.equal(calls, 1);
  assert.throws(() => resolveOpenCommand(target, {}, { platform: 'aix' }), /platform: aix/);
});

test('openReference retains file validation and custom opener behavior', async (t) => {
  const { path } = await fixture(t);
  const calls: unknown[] = [];
  await openReference({ path }, { defaultOpener: ['editor', '{path}'] }, {
    ...linux, execute: async (command) => { calls.push(command); },
  });
  assert.deepEqual(calls, [{ command: 'editor', args: [path] }]);
  await assert.rejects(openReference({ path: `${path}.missing` }, {}, linux), /ENOENT/);
});
