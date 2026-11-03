#!/usr/bin/env node
/**
 * dsh-raccoon-checkin —— 给 `dsh-providers-hub` 的 Raccoon（商汤小浣熊）补上每日签到。
 *
 * ## 为什么是「补丁器」而不是直接改文件
 *
 * 补丁改的是 profile 里 `node_modules/dsh-providers-hub/lib/**` 的构建产物。
 * 一旦 `pnpm update` / 重装 / 升级版本，`node_modules` 会被整个换掉，补丁随之消失。
 * 所以这里存的是**可重放的补丁描述**：升级之后再跑一次本脚本，补丁就回来了。
 *
 * 两种打法（见 patch-data.json 的 `mode`）：
 *
 * - `file`  ：整文件替换。只用于在多个版本之间**逐字节相同**的文件，并带 SHA256 守卫：
 *             目标既不等于「已知原版」也不等于「已打补丁版」时拒绝覆盖。
 * - `anchor`：锚点替换。用于会随版本变化的文件：每条锚点必须**唯一命中**，
 *             命中 0 次（版本变了）或 >1 次（锚点不唯一）都立即报错、整体不写盘。
 *
 * ## 用法
 *
 *   node patch.mjs                  # 打到本机已装的 profile（自动探测）
 *   node patch.mjs --check          # 只检查，不写盘（--dry-run 同义）
 *   node patch.mjs --revert         # 用首次打补丁留下的 .rcc-orig 备份还原
 *   node patch.mjs --profile web    # 指定 profile 名
 *   node patch.mjs --dir <包目录>    # 指定 dsh-providers-hub 包目录
 *   node patch.mjs --json           # 机器可读输出
 *   node patch.mjs --no-verify      # 跳过写盘后的语法自检
 *
 * 退出码：0 = 全部就位；1 = 有待处理问题；2 = 参数/目标错误。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA = join(HERE, 'patch-data.json');
const BACKUP_SUFFIX = '.rcc-orig';
const PACKAGE_NAME = 'dsh-providers-hub';

const USAGE = `dsh-raccoon-checkin —— Raccoon（商汤小浣熊）每日签到补丁

用法:
  node patch.mjs                打到本机已装的 profile（自动探测 desktop / web）
  node patch.mjs --check        只检查，不写盘
  node patch.mjs --revert       还原为打补丁前的文件
  node patch.mjs --profile <n>  指定 DSH profile 名
  node patch.mjs --dir <path>   指定 dsh-providers-hub 包目录（或 profile 目录）
  node patch.mjs --json         输出机器可读结果
  node patch.mjs --no-verify    跳过写盘后的语法自检
  node patch.mjs --force        file 模式哈希不符时仍然覆盖（有风险）
  node patch.mjs --version      打印版本

退出码: 0 全部就位 / 1 有待处理问题 / 2 参数或目标错误`;

function fail(message, code = 2) {
  console.error(`错误: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    dir: null,
    profile: null,
    data: DEFAULT_DATA,
    check: false,
    revert: false,
    force: false,
    verify: true,
    json: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (name) => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`${name} 缺少参数值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--dir': out.dir = resolve(takeValue('--dir')); break;
      case '--profile': out.profile = takeValue('--profile'); break;
      case '--data': out.data = resolve(takeValue('--data')); break;
      case '--check':
      case '--dry-run': out.check = true; break;
      case '--revert': out.revert = true; break;
      case '--force': out.force = true; break;
      case '--no-verify': out.verify = false; break;
      case '--json': out.json = true; break;
      case '--version': out.version = true; break;
      case '--help':
      case '-h': console.log(USAGE); process.exit(0); break;
      default: fail(`未知参数: ${arg}\n\n${USAGE}`);
    }
  }
  return out;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function countOf(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) return count;
    count += 1;
    index = found + needle.length;
  }
}

/** 把 `--dir` 的参数归一化成「包目录」：允许给 profile 目录或 node_modules。 */
function normalizeTarget(input) {
  const asPackage = join(input, 'package.json');
  if (existsSync(asPackage)) {
    try {
      const manifest = JSON.parse(readFileSync(asPackage, 'utf8'));
      if (manifest.name === PACKAGE_NAME) return { dir: input, version: manifest.version };
    }
    catch {
      // 继续往下试：也许给的是 profile 目录，它的 package.json 不是这个包
    }
  }
  for (const candidate of [join(input, 'node_modules', PACKAGE_NAME), join(input, PACKAGE_NAME)]) {
    if (existsSync(join(candidate, 'package.json'))) return normalizeTarget(candidate);
  }
  return null;
}

/** 自动探测本机已装的包（DSH_PROFILE → desktop / web / default）。 */
function detectTarget(profile) {
  const home = homedir();
  const names = [];
  if (profile) names.push(profile);
  if (process.env.DSH_PROFILE) names.push(process.env.DSH_PROFILE);
  names.push('desktop', 'web', 'default');
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const hit = normalizeTarget(join(home, '.dsh', 'profiles', name));
    if (hit) return hit;
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));

if (args.version) {
  const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
  console.log(`${manifest.name} ${manifest.version}`);
  process.exit(0);
}

const target = args.dir ? normalizeTarget(args.dir) : detectTarget(args.profile);
if (!target) {
  fail(
    args.dir
      ? `在 ${args.dir} 里找不到 ${PACKAGE_NAME}（看的是它的 package.json，以及 node_modules/${PACKAGE_NAME}）`
      : `没找到已安装的 ${PACKAGE_NAME}。请先装好插件，或用 --dir 指定包目录 / --profile 指定 profile 名`,
  );
}
if (!existsSync(args.data)) fail(`补丁描述文件不存在: ${args.data}`);

const data = JSON.parse(readFileSync(args.data, 'utf8'));
if (!Array.isArray(data.files) || data.files.length === 0) fail('补丁描述文件里没有 files');

/** 资产路径：优先相对补丁描述文件所在目录，其次相对脚本自身。 */
function assetPath(asset) {
  const besideData = join(dirname(args.data), asset);
  return existsSync(besideData) ? besideData : join(HERE, asset);
}

const log = args.json ? () => {} : (...parts) => console.log(...parts);
const report = { ok: true, mode: args.revert ? 'revert' : args.check ? 'check' : 'apply', target: target.dir, version: target.version, files: [], problems: [] };
const pending = [];

if (!args.json) {
  log(`目标包 : ${target.dir}`);
  log(`版本   : ${PACKAGE_NAME}@${target.version}`);
  log(`模式   : ${args.revert ? '还原' : args.check ? '检查' : '打补丁'}`);
  log('');
}

for (const file of data.files) {
  const abs = join(target.dir, file.path);
  const done = (status, extra = {}) => {
    report.files.push({ path: file.path, status, ...extra });
    if (!args.json) log(`- ${file.path}: ${extra.message ?? status}`);
  };

  if (!existsSync(abs)) {
    report.ok = false;
    report.problems.push(`${file.path}: 文件不存在`);
    done('missing');
    continue;
  }
  const backup = abs + BACKUP_SUFFIX;

  if (args.revert) {
    if (!existsSync(backup)) { done('skipped', { message: '没有备份，跳过' }); continue; }
    pending.push({ abs, path: file.path, bytes: readFileSync(backup), text: null, action: '还原' });
    continue;
  }

  if (file.mode === 'file') {
    const current = readFileSync(abs);
    const currentSha = sha256(current);
    if (currentSha === file.patchedSha256) { done('applied', { message: '已应用（整文件）' }); continue; }
    const known = Array.isArray(file.expectedOriginalSha256) ? file.expectedOriginalSha256 : [];
    if (!known.includes(currentSha) && !args.force) {
      report.ok = false;
      report.problems.push(
        `${file.path}: 当前内容既不是已知原版也不是已打补丁版（sha256=${currentSha}）。`
        + ' 上游很可能改过这个文件，整文件覆盖会丢掉改动，已拒绝；确认无碍可加 --force。',
      );
      done('conflict');
      continue;
    }
    pending.push({ abs, path: file.path, bytes: readFileSync(assetPath(file.asset)), text: null, action: '整文件替换' });
    continue;
  }

  const original = readFileSync(abs, 'utf8');
  let text = original;
  let applied = 0;
  let broken = false;
  for (const edit of file.edits ?? []) {
    const find = edit.find.join('\n');
    const replace = edit.replace.join('\n');
    if (countOf(text, replace) === 1) { applied += 1; continue; }
    const hits = countOf(text, find);
    if (hits !== 1) {
      report.ok = false;
      report.problems.push(
        `${file.path}: 锚点命中 ${hits} 次（应为 1）—— 版本可能变了。锚点首行: ${JSON.stringify(edit.find[0] ?? '')}`,
      );
      broken = true;
      break;
    }
    text = text.replace(find, () => replace);
    applied += 1;
  }
  if (broken) { done('anchor-miss'); continue; }
  if (text === original) { done('applied', { message: `已应用（${applied}/${(file.edits ?? []).length}）` }); continue; }
  pending.push({
    abs,
    path: file.path,
    bytes: null,
    text,
    action: `锚点替换（${applied}/${(file.edits ?? []).length}）`,
  });
}

if (!report.ok) {
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.error('❌ 有文件无法安全打补丁（本次未改动任何文件）：');
    for (const line of report.problems) console.error('   ' + line);
    console.error('');
    console.error('这通常意味着插件换了实现。把上面这些行发回上游 issue，重新对齐锚点即可。');
  }
  process.exit(1);
}

if (pending.length === 0) {
  if (args.json) console.log(JSON.stringify({ ...report, changed: 0 }, null, 2));
  else log('✅ 全部文件已就位，无需改动。');
  process.exit(0);
}

if (args.check) {
  for (const item of pending) {
    report.files.push({ path: item.path, status: 'pending', message: `待${item.action}` });
    log(`· ${item.path}: 待${item.action}`);
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else { log(''); log('（--check 模式，未写盘）'); }
  process.exit(0);
}

for (const item of pending) {
  const backup = item.abs + BACKUP_SUFFIX;
  if (!args.revert && !existsSync(backup)) writeFileSync(backup, readFileSync(item.abs));
  if (item.bytes !== null) writeFileSync(item.abs, item.bytes);
  else writeFileSync(item.abs, item.text, 'utf8');
  report.files.push({ path: item.path, status: args.revert ? 'reverted' : 'patched', message: item.action });
  log(`· ${item.path}: ${item.action}`);
}

// 写盘后语法自检：宿主侧模块语法错误会让 DSH 直接起不来，宁可在这一步拦下。
if (args.verify && !args.revert) {
  const tmp = mkdtempSync(join(tmpdir(), 'rcc-verify-'));
  let broken = null;
  try {
    for (const item of pending) {
      const probe = join(tmp, item.path.replace(/[\\/]/g, '_') + '.mjs');
      copyFileSync(item.abs, probe);
      const result = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' });
      if (result.status !== 0) { broken = { path: item.path, output: (result.stderr || '').trim() }; break; }
    }
  }
  finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (broken) {
    // 回滚：语法都不对，绝不能留在盘上。
    for (const item of pending) {
      const backup = item.abs + BACKUP_SUFFIX;
      if (existsSync(backup)) copyFileSync(backup, item.abs);
    }
    const message = `语法自检失败：${broken.path}\n${broken.output}`;
    if (args.json) console.log(JSON.stringify({ ...report, ok: false, problems: [...report.problems, message] }, null, 2));
    else console.error(`❌ ${message}\n\n已从备份回滚。`);
    process.exit(1);
  }
}

if (args.json) console.log(JSON.stringify({ ...report, changed: pending.length }, null, 2));
else {
  log('');
  if (args.revert) {
    log('✅ 已还原为补丁前的原始文件。');
    log('   还原后同样需要重启 DSH 才生效。');
  }
  else {
    log('✅ 补丁已应用。');
    log('');
    log('生效方式（宿主侧模块在启动时加载，必须重启进程）：');
    log('  1. 自己重启 DSH；');
    log('  2. 重启后刷新页面，Raccoon 卡片上会出现「一键领取积分」。');
  }
}
