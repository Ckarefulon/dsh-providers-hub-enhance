#!/usr/bin/env node
/**
 * dsh-providers-hub-enhance —— 给 `dsh-providers-hub` 打**增强补丁**（可重放、可还原、带守卫）。
 *
 * 目前补三件事：
 *
 * 1. **CodeBuddy（腾讯 `copilot.tencent.com`）出站守卫**：DSH 自己的提示词里有四段会被
 *    国内网关判成「非授权渠道调用」（400 / code 11128），在 fetch 层做语义等价改写。
 *    机制移植自 dsh-wb400-guard，只对 CodeBuddy 一个提供方生效（详见
 *    `assets/codebuddy-guard.js` 的模块头）。
 * 2. **Raccoon（商汤小浣熊）每日签到**：上游「没有签到端点」是漏查，真正的触发器
 *    在办公端（详见 docs/how-it-works.md）。
 * 3. **限流中断后的「解禁后自动继续」**：会话因限流（429 / 额度耗尽）中断时，
 *    在报错行尾给一个可切换的图标按钮，等限流解禁后自动把会话续上；Jet Hub
 *    设置页顶部有一个总开关决定默认行为。
 *
 * ## 为什么是「补丁器」而不是直接改文件
 *
 * 补丁改的是 profile 里 `node_modules/dsh-providers-hub/lib/**` 的构建产物。
 * 一旦 `pnpm update` / 重装 / 升级版本，`node_modules` 会被整个换掉，补丁随之消失。
 * 所以这里存的是**可重放的补丁描述**：升级之后再跑一次本脚本，补丁就回来了。
 *
 * ## 四种打法（见 patch-data.json 的 `mode`）
 *
 * - `file`  ：整文件替换。只用于在多个版本之间**逐字节相同**的文件，并带 SHA256
 *             守卫：目标既不等于「已知原版」也不等于「已打补丁版」时拒绝覆盖。
 * - `anchor`：锚点替换。用于会随版本变化的文件：每条锚点必须**唯一命中**，
 *             命中 0 次（版本变了）或 >1 次（锚点不唯一）都立即报错、整体不写盘。
 * - `create`：**只新建**补丁自带的模块文件（上游没有这个文件）。目标已存在且内容
 *             不认识时拒绝覆盖；`--revert` 只删本补丁自己写的那些。
 * - `anchor-asset`：把 assets/ 里的一整块代码插进锚点前后（`position`）并带幂等
 *             标记（`marker`）。用于「一大段新代码」—— 留在 assets/ 里可读、
 *             可 `node --check`、可单测，而不是塞进 JSON 的行数组（后者一改缩进
 *             就要整体重写，评审也读不出改了什么）。
 *
 * ## ⚠️ 同一个文件可以被**多个**补丁项改
 *
 * 客户端 bundle 就是这样：既有锚点替换，又有两块插入。处理时按**路径分组**、
 * 在同一份内存文本上依次应用 —— 逐项各自读盘再写盘会让后一项整体覆盖前一项，
 * 表现为「只有最后一块生效」（`tests/patch.test.mjs` 有一条用例专门锁它）。
 *
 * ## 用法
 *
 *   node patch.mjs                  # 打到本机已装的 profile（自动探测）
 *   node patch.mjs --check          # 只检查，不写盘（--dry-run 同义）
 *   node patch.mjs --revert         # 用首次打补丁留下的 .phc-orig 备份还原
 *   node patch.mjs --profile web    # 指定 profile 名
 *   node patch.mjs --dir <包目录>    # 指定 dsh-providers-hub 包目录
 *   node patch.mjs --json           # 机器可读输出
 *   node patch.mjs --no-verify      # 跳过写盘后的语法自检
 *
 * 退出码：0 = 全部就位；1 = 有待处理问题；2 = 参数/目标错误。
 *
 * @module patch
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFileSyntax } from './scripts/syntax-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA = join(HERE, 'patch-data.json');
/** 备份后缀：`.phc-orig` = providers-hub-enhance 的原始文件。 */
const BACKUP_SUFFIX = '.phc-orig';
/** 新建文件清单（`--revert` 据此删除「确实由本补丁建的文件」）。 */
const MANIFEST = '.phc-created.json';
const PACKAGE_NAME = 'dsh-providers-hub';

const USAGE = `dsh-providers-hub-enhance —— dsh-providers-hub 增强补丁

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

/**
 * 参数 / 目标错误。
 *
 * ⚠️ 用抛错而不是 `process.exit`：本文件同时是**模块**（单测直接调 `runPatch`）。
 * 一遇到错就退出进程会把测试进程一起带走，且拿不到「退出码 2」这个契约。
 */
export class PatchUsageError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = 'PatchUsageError';
    this.code = code;
  }
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
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (name) => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new PatchUsageError(`${name} 缺少参数值`);
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
      case '-h': out.help = true; break;
      default: throw new PatchUsageError(`未知参数: ${arg}\n\n${USAGE}`);
    }
  }
  return out;
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

/**
 * 本补丁**新建**过的文件清单。
 *
 * ⚠️ 必须持久化而不是从 patch-data 现推：用户可能先升级插件（清掉 node_modules）、
 * 再回退本补丁 —— 那时 patch-data 仍列着这些路径，但只有清单能证明「当初确实是
 * 我们建的」。清单缺失时退回按 patch-data 判断（对老版本补丁友好）。
 */
export function readManifest(dir) {
  const path = join(dir, MANIFEST);
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed?.created) ? new Set(parsed.created) : null;
  }
  catch {
    return null;
  }
}

function writeManifest(dir, created) {
  const path = join(dir, MANIFEST);
  if (created.size === 0) { rmSync(path, { force: true }); return; }
  writeFileSync(path, `${JSON.stringify({ schema: 'dsh-providers-hub-enhance/created/v1', created: [...created].sort() }, null, 2)}\n`, 'utf8');
}

/**
 * 按**文件路径**分组：同一个文件可能被多个补丁项改（比如客户端 bundle 既有锚点
 * 替换、又有两块插入）。
 *
 * ⚠️ 必须分组而不是逐项处理：逐项各自从磁盘读原文再写盘，后一项会把前一项的
 * 改动**整体覆盖**掉 —— 于是「锚点替换 + 插入代码块」只有最后一块生效，且第二
 * 遍还会因为前一块已被覆盖而反复重打。这与 `countOf`/`replace` 的幂等判据是
 * 两件事，别指望前者能救后者。
 */
export function groupByPath(files) {
  const groups = new Map();
  for (const file of files) {
    const list = groups.get(file.path);
    if (list === undefined) groups.set(file.path, [file]);
    else list.push(file);
  }
  return groups;
}

/**
 * 跑一次补丁。
 *
 * @param argv - 命令行参数（不含 `node script`）。
 * @param options - `{ quiet }` 只影响输出收集，不改变行为。
 * @returns `{ exitCode, report, lines }`：退出码、机器可读结果、要打印的行。
 */
export function runPatch(argv, options = {}) {
  const lines = [];
  const say = (line = '') => { lines.push(line); };
  const args = parseArgs(argv);

  if (args.help) {
    for (const line of USAGE.split('\n')) say(line);
    return { exitCode: 0, report: null, lines };
  }
  if (args.version) {
    const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
    say(`${manifest.name} ${manifest.version}`);
    return { exitCode: 0, report: null, lines };
  }

  const target = args.dir ? normalizeTarget(args.dir) : detectTarget(args.profile);
  if (!target) {
    throw new PatchUsageError(
      args.dir
        ? `在 ${args.dir} 里找不到 ${PACKAGE_NAME}（看的是它的 package.json，以及 node_modules/${PACKAGE_NAME}）`
        : `没找到已安装的 ${PACKAGE_NAME}。请先装好插件，或用 --dir 指定包目录 / --profile 指定 profile 名`,
    );
  }
  if (!existsSync(args.data)) throw new PatchUsageError(`补丁描述文件不存在: ${args.data}`);

  const data = JSON.parse(readFileSync(args.data, 'utf8'));
  if (!Array.isArray(data.files) || data.files.length === 0) throw new PatchUsageError('补丁描述文件里没有 files');

  /** 资产路径：优先相对补丁描述文件所在目录，其次相对脚本自身。 */
  const assetPath = (asset) => {
    const besideData = join(dirname(args.data), asset);
    return existsSync(besideData) ? besideData : join(HERE, asset);
  };

  const log = args.json ? () => {} : (...parts) => { say(parts.join(' ')); };
  const report = {
    ok: true,
    mode: args.revert ? 'revert' : args.check ? 'check' : 'apply',
    target: target.dir,
    version: target.version,
    files: [],
    problems: [],
  };
  const pending = [];
  const newlyCreated = new Set();
  const deletions = [];

  if (!args.json) {
    log(`目标包 : ${target.dir}`);
    log(`版本   : ${PACKAGE_NAME}@${target.version}`);
    log(`模式   : ${args.revert ? '还原' : args.check ? '检查' : '打补丁'}`);
    log('');
  }

  for (const [relPath, entries] of groupByPath(data.files)) {
    const abs = join(target.dir, relPath);
    const done = (status, extra = {}) => {
      report.files.push({ path: relPath, status, ...extra });
      if (!args.json) log(`- ${relPath}: ${extra.message ?? status}`);
    };

    /** 该组里所有 `create` 项（至多一项；多余的直接报错，免得两份资产互相踩）。 */
    const creates = entries.filter((entry) => entry.mode === 'create');
    if (creates.length > 1) throw new PatchUsageError(`${relPath}: 同一个路径只能有一条 create 项`, 1);

    if (creates.length === 1) {
      const file = creates[0];
      const backup = abs + BACKUP_SUFFIX;
      const assetBytes = readFileSync(assetPath(file.asset));
      const assetSha = sha256(assetBytes);
      if (file.patchedSha256 !== undefined && file.patchedSha256 !== assetSha) {
        throw new PatchUsageError(`${relPath}: 资产哈希与 patch-data 声明不符（资产 ${assetSha}，声明 ${file.patchedSha256}）`, 1);
      }
      if (args.revert) {
        // ⚠️ 只删「确实由本补丁建的」文件：清单里有它，或没有清单时按 patch-data 判断。
        //    内容必须仍是补丁那一版（用户手改过就别动）。
        if (!existsSync(abs)) { done('skipped', { message: '文件不存在，无需处理' }); continue; }
        const manifest = readManifest(target.dir);
        const ours = manifest === null ? true : manifest.has(relPath);
        if (!ours) { done('skipped', { message: '不是本补丁建的文件，跳过' }); continue; }
        // 曾经 `--force` 覆盖过别人的同名文件 ⇒ 有备份，按备份还原而不是删除。
        if (existsSync(backup)) {
          pending.push({ abs, path: relPath, bytes: readFileSync(backup), text: null, action: '还原（--force 覆盖前的原文件）' });
          continue;
        }
        if (sha256(readFileSync(abs)) !== assetSha) {
          done('skipped', { message: '内容已被改过，保留不动' });
          continue;
        }
        deletions.push({ abs, path: relPath });
        continue;
      }
      // ⚠️ 清单里登记过这个路径 ⇒ **就是本补丁自己建的**（只是补丁升级后哈希变了）。
      //    这种情况必须允许直接覆盖：否则每次改资产内容，用户都得手动 `--force`，
      //    而那个开关本来是为「别人写的同名文件」准备的。清单是唯一的归属证据。
      // 注意作用域：`ownedByUs` 要活到下面的 `pending.push`，故在 `if` 外声明。
      const manifestForCreate = readManifest(target.dir);
      const ownedByUs = manifestForCreate !== null && manifestForCreate.has(relPath);
      if (existsSync(abs)) {
        if (sha256(readFileSync(abs)) === assetSha) { done('applied', { message: '已应用（新建）' }); continue; }
        if (!ownedByUs && !args.force) {
          report.ok = false;
          report.problems.push(
            `${relPath}: 目标已存在且内容不是本补丁那一版（sha256=${sha256(readFileSync(abs))}）。`
            + ' 这个文件本该只由本补丁创建，覆盖会丢掉别人写的内容，已拒绝；确认无碍可加 --force。',
          );
          done('conflict');
          continue;
        }
      }
      pending.push({ abs, path: relPath, bytes: assetBytes, text: null, action: ownedByUs ? '更新（本补丁先前创建的文件）' : '新建文件' });
      // 只有**真的新建**时才登记：覆盖既有文件不该让 `--revert` 去删它。
      if (!existsSync(abs)) newlyCreated.add(relPath);
      continue;
    }

    if (!existsSync(abs)) {
      report.ok = false;
      report.problems.push(`${relPath}: 文件不存在`);
      done('missing');
      continue;
    }
    const backup = abs + BACKUP_SUFFIX;

    if (args.revert) {
      if (!existsSync(backup)) { done('skipped', { message: '没有备份，跳过' }); continue; }
      pending.push({ abs, path: relPath, bytes: readFileSync(backup), text: null, action: '还原' });
      continue;
    }

    // ── 整文件替换：它本身就定义了「最终内容」，不能与同组的其它项共存 ──
    const file = entries.find((entry) => entry.mode === 'file');
    if (file !== undefined) {
      if (entries.length > 1) throw new PatchUsageError(`${relPath}: 整文件替换不能与其它补丁项共存于同一路径`, 1);
      const current = readFileSync(abs);
      const currentSha = sha256(current);
      if (currentSha === file.patchedSha256) { done('applied', { message: '已应用（整文件）' }); continue; }
      const known = Array.isArray(file.expectedOriginalSha256) ? file.expectedOriginalSha256 : [];
      if (!known.includes(currentSha) && !args.force) {
        report.ok = false;
        report.problems.push(
          `${relPath}: 当前内容既不是已知原版也不是已打补丁版（sha256=${currentSha}）。`
          + ' 上游很可能改过这个文件，整文件覆盖会丢掉改动，已拒绝；确认无碍可加 --force。',
        );
        done('conflict');
        continue;
      }
      pending.push({ abs, path: relPath, bytes: readFileSync(assetPath(file.asset)), text: null, action: '整文件替换' });
      continue;
    }

    // ── 按声明顺序在**同一份内存文本**上依次应用该组的所有项 ──
    const original = readFileSync(abs, 'utf8');
    let text = original;
    let applied = 0;
    let total = 0;
    let broken = false;
    for (const entry of entries) {
      if (entry.mode === 'anchor-asset') {
        total += 1;
        const anchor = (entry.anchor ?? []).join('\n');
        if (anchor === '') throw new PatchUsageError(`${relPath}: anchor-asset 缺少 anchor`, 1);
        const marker = entry.marker ?? '';
        // 幂等：文件里已经出现我们的标记 ⇒ 这一块早就插过了。
        if (marker !== '' && text.includes(marker)) { applied += 1; continue; }
        const hits = countOf(text, anchor);
        if (hits !== 1) {
          report.ok = false;
          report.problems.push(
            `${relPath}: 插入锚点命中 ${hits} 次（应为 1）—— 版本可能变了。锚点首行: ${JSON.stringify((entry.anchor ?? [])[0] ?? '')}`,
          );
          broken = true;
          break;
        }
        const assetText = readFileSync(assetPath(entry.asset), 'utf8').replace(/\n+$/, '');
        const glued = entry.position === 'after' ? `${anchor}\n${assetText}` : `${assetText}\n${anchor}`;
        text = text.replace(anchor, () => glued);
        applied += 1;
        continue;
      }
      if (entry.mode !== 'anchor') throw new PatchUsageError(`${relPath}: 未知 mode ${String(entry.mode)}`, 1);
      total += (entry.edits ?? []).length;
      for (const edit of entry.edits ?? []) {
        const find = edit.find.join('\n');
        const replace = edit.replace.join('\n');
        if (countOf(text, replace) === 1) { applied += 1; continue; }
        const hits = countOf(text, find);
        if (hits !== 1) {
          report.ok = false;
          report.problems.push(
            `${relPath}: 锚点命中 ${hits} 次（应为 1）—— 版本可能变了。锚点首行: ${JSON.stringify(edit.find[0] ?? '')}`,
          );
          broken = true;
          break;
        }
        text = text.replace(find, () => replace);
        applied += 1;
      }
      if (broken) break;
    }
    if (broken) { done('anchor-miss'); continue; }
    if (text === original) { done('applied', { message: `已应用（${applied}/${total}）` }); continue; }
    pending.push({ abs, path: relPath, bytes: null, text, action: `锚点替换（${applied}/${total}）` });
  }

  if (!report.ok) {
    for (const line of report.problems) say(`   ${line}`);
    return { exitCode: 1, report, lines };
  }

  if (pending.length === 0 && deletions.length === 0) {
    if (!args.json) log('✅ 全部文件已就位，无需改动。');
    return { exitCode: 0, report: { ...report, changed: 0 }, lines };
  }

  if (args.check) {
    for (const item of pending) {
      report.files.push({ path: item.path, status: 'pending', message: `待${item.action}` });
      log(`· ${item.path}: 待${item.action}`);
    }
    for (const item of deletions) {
      report.files.push({ path: item.path, status: 'pending', message: '待删除（本补丁新建）' });
      log(`· ${item.path}: 待删除（本补丁新建）`);
    }
    log('');
    log('（--check 模式，未写盘）');
    return { exitCode: 0, report: { ...report, changed: pending.length + deletions.length }, lines };
  }

  if (args.revert) {
    for (const item of deletions) {
      rmSync(item.abs, { force: true });
      rmSync(item.abs + BACKUP_SUFFIX, { force: true });
      report.files.push({ path: item.path, status: 'reverted', message: '已删除（本补丁新建）' });
      log(`· ${item.path}: 已删除（本补丁新建）`);
    }
    for (const item of pending) {
      const backup = item.abs + BACKUP_SUFFIX;
      copyFileSync(backup, item.abs);
      rmSync(backup, { force: true });
      report.files.push({ path: item.path, status: 'reverted', message: item.action });
      log(`· ${item.path}: ${item.action}`);
    }
    writeManifest(target.dir, new Set());
    log('');
    log('✅ 已还原为补丁前的原始文件。');
    log('   还原后同样需要重启 DSH 才生效。');
    return { exitCode: 0, report: { ...report, changed: deletions.length + pending.length }, lines };
  }

  for (const item of pending) {
    const backup = item.abs + BACKUP_SUFFIX;
    if (!existsSync(backup) && existsSync(item.abs)) writeFileSync(backup, readFileSync(item.abs));
    mkdirSync(dirname(item.abs), { recursive: true });
    if (item.bytes !== null) writeFileSync(item.abs, item.bytes);
    else writeFileSync(item.abs, item.text, 'utf8');
    report.files.push({ path: item.path, status: 'patched', message: item.action });
    log(`· ${item.path}: ${item.action}`);
  }

  // 新建文件清单：只在真正写盘后更新（--check 不写）。
  if (newlyCreated.size > 0) {
    const existing = readManifest(target.dir) ?? new Set();
    for (const path of newlyCreated) existing.add(path);
    writeManifest(target.dir, existing);
  }

  // 写盘后语法自检：宿主侧模块语法错误会让 DSH 直接起不来，宁可在这一步拦下。
  //
  // ⚠️ 判据是**进程内**的（`scripts/syntax-check.mjs`）：DSH 自己的 Windows 沙箱
  // 禁止 `spawn`（EPERM），而 `node --check` 是子进程 —— 只靠它的话，受限环境里
  // 这一层保护等于不存在（只能「如实跳过」，语法错误留到重启后炸）。
  if (args.verify) {
    let broken = null;
    for (const item of pending) {
      const source = item.bytes !== null ? new TextDecoder().decode(item.bytes) : item.text;
      const result = checkFileSyntax(source);
      if (result.ok === false) { broken = { path: item.path, output: result.message }; break; }
    }
    if (broken) {
      // 回滚：语法都不对，绝不能留在盘上。
      for (const item of pending) {
        const backup = item.abs + BACKUP_SUFFIX;
        if (newlyCreated.has(item.path)) { rmSync(item.abs, { force: true }); continue; }
        if (existsSync(backup)) copyFileSync(backup, item.abs);
      }
      const message = `语法自检失败：${broken.path}\n${broken.output}`;
      say(`❌ ${message}`);
      say('');
      say('已从备份回滚。');
      return { exitCode: 1, report: { ...report, ok: false, problems: [...report.problems, message] }, lines };
    }
  }

  log('');
  log('✅ 补丁已应用。');
  log('');
  log('生效方式（宿主侧模块在启动时加载，必须重启进程）：');
  log('  1. 自己重启 DSH；');
  log('  2. 重启后刷新页面：Raccoon 卡片上出现「一键领取积分」，');
  log('     限流中断的报错行尾出现「解禁后自动继续」图标按钮；');
  log('  3. 走 CodeBuddy（buddy）时不再撞 400/11128 —— 想确认就先跑 `node scripts/verify-guard.mjs`。');
  return { exitCode: 0, report: { ...report, changed: pending.length }, lines };
}

// ── CLI 入口：只有**直接运行**这个文件时才执行（被 import 时不跑）──
const entry = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes('--json');
  try {
    const result = runPatch(argv);
    for (const line of result.lines) console.log(line);
    if (wantsJson && result.report !== null) console.log(JSON.stringify(result.report, null, 2));
    if (result.exitCode !== 0 && result.report !== null && !wantsJson) {
      console.error('❌ 有文件无法安全打补丁（本次未改动任何文件）：');
    }
    process.exit(result.exitCode);
  }
  catch (error) {
    console.error(`错误: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof PatchUsageError ? error.code : 1);
  }
}
