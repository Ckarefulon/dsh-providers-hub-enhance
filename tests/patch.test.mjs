// 用假的包目录与假的补丁描述，覆盖补丁器的四种关键行为：
//   1. 两种模式都能打上；
//   2. 幂等（第二遍不改文件）；
//   3. 锚点失效 / 整文件哈希不符时**拒绝写盘**；
//   4. --revert 能还原，语法自检失败会自动回滚。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCHER = join(HERE, '..', 'patch.mjs');
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const ANCHOR_ORIGINAL = [
  'const a = 1;',
  '// MARK:begin',
  'const flag = false;',
  '// MARK:end',
  'export { a, flag };',
  '',
].join('\n');
const ANCHOR_PATCHED = [
  'const a = 1;',
  '// MARK:begin',
  'const flag = true;',
  'const extra = 2;',
  '// MARK:end',
  'export { a, flag };',
  '',
].join('\n');

const WHOLE_ORIGINAL = 'export const whole = "original";\n';
const WHOLE_PATCHED = 'export const whole = "patched";\n';

/** 造一个临时环境：假插件包 + 假补丁描述 + 假资产。 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rcc-test-'));
  const pkg = join(root, 'dsh-providers-hub');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-providers-hub', version: '0.0.0-test' }));
  writeFileSync(join(pkg, 'lib', 'anchor.js'), ANCHOR_ORIGINAL);
  writeFileSync(join(pkg, 'lib', 'whole.js'), WHOLE_ORIGINAL);

  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'whole.js'), WHOLE_PATCHED);

  const data = {
    schema: 'test/v1',
    files: [
      {
        path: 'lib/anchor.js',
        mode: 'anchor',
        edits: [{ find: ['const flag = false;'], replace: ['const flag = true;', 'const extra = 2;'] }],
      },
      {
        path: 'lib/whole.js',
        mode: 'file',
        asset: 'assets/whole.js',
        expectedOriginalSha256: [sha256(WHOLE_ORIGINAL)],
        patchedSha256: sha256(WHOLE_PATCHED),
      },
    ],
  };
  writeFileSync(join(root, 'patch-data.json'), JSON.stringify(data, null, 2));
  return { root, pkg, run: (extra = []) => run(root, pkg, extra) };
}

function run(root, pkg, extra) {
  const result = spawnSync(process.execPath, [PATCHER, '--dir', pkg, '--data', join(root, 'patch-data.json'), ...extra], {
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('两种模式都能打上，且第二遍是幂等的', () => {
  const { pkg, run } = makeFixture();

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(join(pkg, 'lib', 'anchor.js'), 'utf8'), ANCHOR_PATCHED);
  assert.equal(readFileSync(join(pkg, 'lib', 'whole.js'), 'utf8'), WHOLE_PATCHED);

  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /全部文件已就位/);
  assert.equal(readFileSync(join(pkg, 'lib', 'anchor.js'), 'utf8'), ANCHOR_PATCHED);
});

test('--check 不写盘，--revert 还原成原样', () => {
  const { pkg, run } = makeFixture();

  const dry = run(['--check']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(readFileSync(join(pkg, 'lib', 'anchor.js'), 'utf8'), ANCHOR_ORIGINAL);

  assert.equal(run().status, 0);
  const revert = run(['--revert']);
  assert.equal(revert.status, 0, revert.stderr);
  assert.equal(readFileSync(join(pkg, 'lib', 'anchor.js'), 'utf8'), ANCHOR_ORIGINAL);
  assert.equal(readFileSync(join(pkg, 'lib', 'whole.js'), 'utf8'), WHOLE_ORIGINAL);
});

test('锚点失效时整体拒绝写盘（另一个文件也不动）', () => {
  const { pkg, run } = makeFixture();
  writeFileSync(join(pkg, 'lib', 'anchor.js'), ANCHOR_ORIGINAL.replace('const flag = false;', 'const flag = 0;'));

  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /锚点命中 0 次/);
  // 锚点文件没被改动，整文件替换也不该发生
  assert.equal(readFileSync(join(pkg, 'lib', 'whole.js'), 'utf8'), WHOLE_ORIGINAL);
});

test('整文件内容的 sha256 不认识时拒绝覆盖，--force 才覆盖', () => {
  const { pkg, run } = makeFixture();
  writeFileSync(join(pkg, 'lib', 'whole.js'), 'export const whole = "someone else edited me";\n');

  const blocked = run();
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /既不是已知原版也不是已打补丁版/);

  const forced = run(['--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(readFileSync(join(pkg, 'lib', 'whole.js'), 'utf8'), WHOLE_PATCHED);
});

test('语法自检失败会自动回滚', () => {
  const { root, pkg, run } = makeFixture();
  const data = JSON.parse(readFileSync(join(root, 'patch-data.json'), 'utf8'));
  data.files = [{
    path: 'lib/anchor.js',
    mode: 'anchor',
    edits: [{ find: ['const flag = false;'], replace: ['const flag = ;'] }],
  }];
  writeFileSync(join(root, 'patch-data.json'), JSON.stringify(data, null, 2));

  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /语法自检失败/);
  assert.equal(readFileSync(join(pkg, 'lib', 'anchor.js'), 'utf8'), ANCHOR_ORIGINAL);
});

test('--json 输出可被解析，并带 ok/changed 字段', () => {
  const { run } = makeFixture();
  const result = run(['--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.changed, 2);
});

test('找不到目标包时退出码为 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'rcc-empty-'));
  const result = spawnSync(process.execPath, [PATCHER, '--dir', root], { encoding: 'utf8' });
  rmSync(root, { recursive: true, force: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /找不到 dsh-providers-hub/);
});
