import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'refs-nvim-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'quote\' " $file; $(touch NEVER).ts');
  await writeFile(file, 'example');
  await writeFile(join(dir, 'cmux'), '#!/bin/bash\nprintf "%s\\0" "$@" >> "$CMUX_LOG"\n', { mode: 0o755 });
  await writeFile(join(dir, 'nvim'), '#!/bin/bash\nprintf "%s\\0" "$@" > "$NVIM_LOG"\nexit "${EDITOR_EXIT:-0}"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CMUX_WORKSPACE_ID: 'caller-workspace', CMUX_SURFACE_ID: 'caller-surface', CMUX_LOG: join(dir, 'cmux.log'), NVIM_LOG: join(dir, 'nvim.log') };
  return { dir, file, env, run: (...args: string[]) => spawnSync('/bin/bash', [resolve('scripts/cmux-nvim'), ...args], { env, encoding: 'utf8' }) };
}

for (const location of [[], ['42'], ['42', '3']]) {
  test(`direct launch safely passes file and location ${location.join(':') || 'none'}`, async (t) => {
    const f = await fixture(t);
    const result = f.run(f.file, ...location);
    assert.equal(result.status, 0, result.stderr);
    const call = (await readFile(f.env.CMUX_LOG, 'utf8')).split('\0');
    assert.deepEqual(call.slice(0, 2), ['rpc', 'surface.split']);
    const params = JSON.parse(call[2]);
    assert.equal(params.initial_input, undefined);
    assert.equal(params.workspace_id, 'caller-workspace');
    assert.equal(params.surface_id, 'caller-surface');
    assert.equal(params.direction, 'right');
    assert.equal(params.focus, true);
    const editor = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', params.initial_command], {
      env: { ...f.env, CMUX_WORKSPACE_ID: 'new-workspace', CMUX_SURFACE_ID: 'new-surface' }, encoding: 'utf8', cwd: f.dir,
    });
    assert.equal(editor.status, 0, editor.stderr);
    assert.deepEqual((await readFile(f.env.NVIM_LOG, 'utf8')).split('\0').slice(0, -1), [
      ...(location.length ? [`+call cursor(${location[0]},${location[1] || '1'})`] : []), '--', f.file,
    ]);
    const calls = (await readFile(f.env.CMUX_LOG, 'utf8')).split('\0');
    assert.deepEqual(calls.slice(3, 5), ['rpc', 'surface.close']);
    assert.deepEqual(JSON.parse(calls[5]), { workspace_id: 'new-workspace', surface_id: 'new-surface', force: true });
    assert.equal(calls.length, 7);
  });
}

test('failed editor leaves the split open for diagnostics', async (t) => {
  const f = await fixture(t);
  assert.equal(f.run(f.file).status, 0);
  const before = await readFile(f.env.CMUX_LOG, 'utf8');
  const params = JSON.parse(before.split('\0')[2]);
  const result = spawnSync('/bin/bash', ['-c', params.initial_command], { env: { ...f.env, EDITOR_EXIT: '7' } });
  assert.equal(result.status, 7);
  assert.equal(await readFile(f.env.CMUX_LOG, 'utf8'), before);
});

test('invalid locations and missing files fail before creating a split', async (t) => {
  const f = await fixture(t);
  for (const args of [[f.file, '0'], [f.file, '1;quit'], [f.file, '', '-1'], [join(f.dir, 'missing')]]) {
    assert.notEqual(f.run(...args).status, 0);
  }
  await assert.rejects(readFile(f.env.CMUX_LOG), { code: 'ENOENT' });
});
