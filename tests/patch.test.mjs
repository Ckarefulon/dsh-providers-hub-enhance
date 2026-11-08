// 覆盖补丁器的关键行为（四种 mode 都要有用例）：
//   1. 全部 mode 都能打上，且第二遍是**幂等**的；
//   2. `--check` 不写盘，`--revert` 还原成原样（新建文件被删掉）；
//   3. 锚点失效 / 整文件哈希不符 / 新建目标已被占用时**拒绝写盘**；
//   4. 同一个文件被多个补丁项改时，**两项都生效**（而不是后者覆盖前者）。
//
// ⚠️ 这些用例 import `patch.mjs` 的 `runPatch` **在进程内**跑：DSH 的 Windows
// 沙箱禁止 `spawn`，走子进程会让全部用例静默跳过 —— 而「跳过」的用例测不到
// 任何守卫，等于没有测试。罕见情况下仍会遇到「语法自检子进程起不来」，那时
// patch.mjs 会如实跳过自检（那条路径另有用例覆盖）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PatchUsageError, runPatch } from '../patch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const ANCHOR_ORIGINAL = 'const a = 1;\n// MARK:begin\nconst flag = false;\n// MARK:end\nexport { a, flag };\n';
const ANCHOR_PATCHED = 'const a = 1;\n// MARK:begin\nconst flag = true;\nconst extra = 2;\n// MARK:end\nexport { a, flag };\n';

const WHOLE_ORIGINAL = 'export const whole = "original";\n';
const WHOLE_PATCHED = 'export const whole = "patched";\n';

const CREATED_MODULE = 'export const created = true;\n';

const MIXED_ORIGINAL = 'const mixed = 1;\n// MARK:anchor\n// MARK:end\n';
const MIXED_BLOCK = '// MARK:block\nexport function inserted() {}\n';
const MIXED_PATCHED = 'const mixed = 2;\n// MARK:anchor\n// MARK:block\nexport function inserted() {}\n// MARK:end\n';

/**
 * 造一个临时环境：假插件包 + 假补丁描述 + 假资产。
 *
 * @param t - `node:test` 的测试上下文；用于登记临时目录的清理（缺省则靠进程退出兜底）。
 */
function makeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'phc-test-'));
  const pkg = join(root, 'dsh-providers-hub');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-providers-hub', version: '0.0.0-test' }));
  writeFileSync(join(pkg, 'lib', 'anchor.js'), ANCHOR_ORIGINAL);
  writeFileSync(join(pkg, 'lib', 'whole.js'), WHOLE_ORIGINAL);
  // 同一个文件被两个补丁项改：锚点替换 + 插入代码块。
  writeFileSync(join(pkg, 'lib', 'mixed.js'), MIXED_ORIGINAL);

  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'whole.js'), WHOLE_PATCHED);
  writeFileSync(join(root, 'assets', 'created.js'), CREATED_MODULE);
  writeFileSync(join(root, 'assets', 'block.js'), MIXED_BLOCK);

  const data = {
    schema: 'test/v2',
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
      {
        path: 'lib/created.js',
        mode: 'create',
        asset: 'assets/created.js',
        patchedSha256: sha256(CREATED_MODULE),
      },
      {
        path: 'lib/mixed.js',
        mode: 'anchor',
        edits: [{ find: ['const mixed = 1;'], replace: ['const mixed = 2;'] }],
      },
      {
        path: 'lib/mixed.js',
        mode: 'anchor-asset',
        asset: 'assets/block.js',
        marker: '// MARK:block',
        position: 'after',
        anchor: ['// MARK:anchor'],
      },
    ],
  };
  writeFileSync(join(root, 'patch-data.json'), JSON.stringify(data, null, 2));
  const run = (extra = []) => runPatch(
    ['--dir', pkg, '--data', join(root, 'patch-data.json'), '--no-verify', ...extra],
  );
  // ⚠️ 必须登记清理：`mkdtempSync` 造在系统临时目录里，不删就会每次跑测试都留一批
  //    `phc-test-*` 目录（实测这批夹具一度堆到上百个）。`t.after` 即使断言失败也会执行。
  if (t !== undefined && typeof t.after === 'function') {
    t.after(() => rmSync(root, { recursive: true, force: true }));
  }
  return { root, pkg, run };
}

test('四种 mode 都能打上，且第二遍是幂等的', (t) => {
  const { pkg, run } = makeFixture(t);
  const first = run();
  assert.equal(first.exitCode, 0, first.lines.join('\n'));
  assert.equal(readFileSync(join(pkg, 'lib', 'anchor.js'), 'utf8'), ANCHOR_PATCHED);
  assert.equal(readFileSync(join(pkg, 'lib', 'whole.js'), 'utf8'), WHOLE_PATCHED);
  assert.equal(readFileSync(join(pkg, 'lib', 'created.js'), 'utf8'), CREATED_MODULE);
  // ⚠️ 同一个文件的两项必须**都**生效：逐项处理会互相覆盖，只有最后一项留下。
  assert.equal(readFileSync(join(pkg, 'lib', 'mixed.js'), 'utf8'), MIXED_PATCHED);

  const second = run();
  assert.equal(second.exitCode, 0);
  assert.match(second.lines.join('\n'), /全部文件已就位/);
  assert.equal(readFileSync(join(pkg, 'lib', 'mixed.js'), 'utf8'), MIXED_PATCHED);
});

test('--check 不写盘，--revert 还原成原样并删掉新建文件', (t) => {
  const { pkg, run } = makeFixture(t);
  const dry = run(['--check']);
  assert.equal(dry.exitCode, 0, dry.lines.join('\n'));
  assert.equal(readFileSync(join(pkg, 'lib', 'anchor.js'), 'utf8'), ANCHOR_ORIGINAL);
  assert.equal(existsSync(join(pkg, 'lib', 'created.js')), false, '--check 不该创建文件');

  assert.equal(run().exitCode, 0);
  const revert = run(['--revert']);
  assert.equal(revert.exitCode, 0, revert.lines.join('\n'));
  assert.equal(readFileSync(join(pkg, 'lib', 'anchor.js'), 'utf8'), ANCHOR_ORIGINAL);
  assert.equal(readFileSync(join(pkg, 'lib', 'whole.js'), 'utf8'), WHOLE_ORIGINAL);
  assert.equal(readFileSync(join(pkg, 'lib', 'mixed.js'), 'utf8'), MIXED_ORIGINAL);
  assert.equal(existsSync(join(pkg, 'lib', 'created.js')), false, '--revert 应删掉本补丁新建的文件');
  assert.equal(existsSync(join(pkg, '.phc-created.json')), false, '还原后清单也该清掉');
});

test('锚点失效时整体拒绝写盘（其它文件也不动）', (t) => {
  const { pkg, run } = makeFixture(t);
  writeFileSync(join(pkg, 'lib', 'anchor.js'), ANCHOR_ORIGINAL.replace('const flag = false;', 'const flag = 0;'));
  const result = run();
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join('\n'), /锚点命中 0 次/);
  // 锚点文件没被改动，其它文件的改动也不该发生（整体不写盘）。
  assert.equal(readFileSync(join(pkg, 'lib', 'whole.js'), 'utf8'), WHOLE_ORIGINAL);
  assert.equal(existsSync(join(pkg, 'lib', 'created.js')), false);
});

test('整文件内容 sha256 不认识时拒绝覆盖，--force 才覆盖', (t) => {
  const { pkg, run } = makeFixture(t);
  writeFileSync(join(pkg, 'lib', 'whole.js'), 'export const whole = "someone else edited me";\n');
  const blocked = run();
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.lines.join('\n'), /既不是已知原版也不是已打补丁版/);

  const forced = run(['--force']);
  assert.equal(forced.exitCode, 0, forced.lines.join('\n'));
  assert.equal(readFileSync(join(pkg, 'lib', 'whole.js'), 'utf8'), WHOLE_PATCHED);
});

test('create 的目标已被别人占用时拒绝覆盖；--force 后才覆盖，且 --revert 会还原', (t) => {
  const { pkg, run } = makeFixture(t);
  writeFileSync(join(pkg, 'lib', 'created.js'), 'export const created = "not ours";\n');
  const blocked = run();
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.lines.join('\n'), /本该只由本补丁创建/);

  const forced = run(['--force']);
  assert.equal(forced.exitCode, 0, forced.lines.join('\n'));
  assert.equal(readFileSync(join(pkg, 'lib', 'created.js'), 'utf8'), CREATED_MODULE);

  // --force 覆盖过别人的同名文件 ⇒ 还原必须回退成**原文件**而不是删掉它。
  assert.equal(run(['--revert']).exitCode, 0);
  assert.equal(readFileSync(join(pkg, 'lib', 'created.js'), 'utf8'), 'export const created = "not ours";\n');
});

// ===== 真机回归：补丁**升级**后重打（资产内容变了，但文件是上一版自己建的）=====
//
// 2026-11-07 实际踩到：改了 `assets/rate-limit-resume.js` 之后 `sync-hashes` 换了
// 哈希，再打补丁时守卫按「已存在且哈希对不上」直接拒绝，提示要用 `--force`。
// 但那个文件明明是**本补丁自己**建的 —— 归属证据就写在 `.phc-created.json` 里，
// 守卫却只查了「内容哈希是否等于**当前**资产」，等于要求用户每次改资产都手动 --force。
// 正确判据：**清单里有它 = 我们的文件**，允许原地更新。
test('补丁升级后重打：清单里登记过的 create 目标必须允许原地更新（不需要 --force）', (t) => {
  const { root, pkg, run } = makeFixture(t);
  // 第一版打上：此时清单登记了 lib/created.js。
  assert.equal(run().exitCode, 0);
  assert.equal(readFileSync(join(pkg, 'lib', 'created.js'), 'utf8'), CREATED_MODULE);

  // 模拟「补丁升级」：资产内容与声明哈希一起换掉（与 sync-hashes 的效果一致）。
  const upgraded = `${CREATED_MODULE}// v2\n`;
  writeFileSync(join(root, 'assets', 'created.js'), upgraded);
  const data = JSON.parse(readFileSync(join(root, 'patch-data.json'), 'utf8'));
  const entry = data.files.find((file) => file.path === 'lib/created.js');
  entry.patchedSha256 = sha256(upgraded);
  writeFileSync(join(root, 'patch-data.json'), JSON.stringify(data, null, 2));

  const second = run();
  assert.equal(second.exitCode, 0, second.lines.join('\n'));
  assert.equal(readFileSync(join(pkg, 'lib', 'created.js'), 'utf8'), upgraded);
  // 升级覆盖时的动作必须是「更新」，不是再新建一次（否则清单与 revert 语义会乱）。
  assert.match(second.lines.join('\n'), /更新（本补丁先前创建的文件）/);

  // 还原语义：升级覆盖前把**上一版**存了备份 ⇒ `--revert` 退回那一版。
  // （覆盖别人写的内容必须能撤回，覆盖自己的旧版本同理。）
  assert.equal(run(['--revert']).exitCode, 0);
  assert.equal(readFileSync(join(pkg, 'lib', 'created.js'), 'utf8'), CREATED_MODULE);
});

test('--json 输出可被解析，且 changed 按文件数计', (t) => {
  const { run } = makeFixture(t);
  const result = run(['--json']);
  assert.equal(result.exitCode, 0, result.lines.join('\n'));
  assert.equal(result.report.ok, true);
  // 四份文件：anchor / whole / created / mixed（mixed 有两项但算一个文件）。
  assert.equal(result.report.changed, 4);
});

test('找不到目标包时抛参数错误（退出码 2）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phc-empty-'));
  try {
    assert.throws(() => runPatch(['--dir', root]), (error) => {
      assert.ok(error instanceof PatchUsageError);
      assert.equal(error.code, 2);
      assert.match(error.message, /找不到 dsh-providers-hub/);
      return true;
    });
  }
  finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('资产哈希与 patch-data 声明不符时立刻拒绝（不写任何文件）', (t) => {
  const { root, pkg, run } = makeFixture(t);
  const data = JSON.parse(readFileSync(join(root, 'patch-data.json'), 'utf8'));
  const target = data.files.find((file) => file.mode === 'create');
  target.patchedSha256 = '0'.repeat(64);
  writeFileSync(join(root, 'patch-data.json'), JSON.stringify(data, null, 2));
  assert.throws(() => run(), (error) => {
    assert.ok(error instanceof PatchUsageError);
    assert.equal(error.code, 1);
    assert.match(error.message, /资产哈希与 patch-data 声明不符/);
    return true;
  });
  assert.equal(existsSync(join(pkg, 'lib', 'created.js')), false);
});
