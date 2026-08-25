// 单测总入口：依次跑四个套件，任一失败则退出码非零（供 npm test / CI 使用）
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const suites = [
  'refusal.test.mjs',
  'asr-clean.test.mjs',
  'google-translate.test.mjs',
  'llm-e2e.test.mjs',
];

let failed = 0;
for (const s of suites) {
  console.log(`\n===== ${s} =====`);
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(s, import.meta.url))], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(`\n===== 总计: ${suites.length - failed}/${suites.length} 套通过 =====`);
process.exit(failed ? 1 : 0);
