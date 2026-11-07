// 重算并回写 patch-data.json 里由 assets 决定的哈希。
// ⚠️ 只改这三处：create 的 patchedSha256 / file 模式的 patchedSha256。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = join(ROOT, 'patch-data.json');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const data = JSON.parse(readFileSync(DATA, 'utf8'));
for (const file of data.files) {
  if (file.mode !== 'create' && file.mode !== 'file') continue;
  const asset = readFileSync(join(ROOT, file.asset));
  const next = sha(asset);
  if (file.patchedSha256 !== next) {
    console.log(`${file.path}: ${file.patchedSha256} -> ${next}`);
    file.patchedSha256 = next;
  }
}
writeFileSync(DATA, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
console.log('patch-data.json updated');
