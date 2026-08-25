// 离屏引擎打包器：把 src/offscreen/ 下的 ES 模块按依赖顺序拼接成单文件产物。
//
// 为什么不用 rollup/esbuild：模块拆分是受控的（模块间只有单行 import、声明处 export），
// 固定顺序拼接 + 剥离 import/export 即可得到与"单文件时代"语义一致的产物，
// 零依赖、可在打包时做引用链断言。新增模块时在 ORDER 里登记即可。

const fs = require('fs');
const path = require('path');

const SRC_OFFSCREEN = path.join(__dirname, '..', '..', 'src', 'offscreen');

// 拼接顺序 = 依赖顺序（被依赖者在前）。engine-env 必须最先：
// 它持有全引擎唯一的 transformers 引入（打包时保留在产物里并替换为版本化文件名）。
const ORDER = [
  'engine-env.js',
  'bus.js',
  'asr-clean.js',
  'asr-cloud.js',
  'asr-local.js',
  'tr-google.js',
  'tr-deepl.js',
  'tr-llm.js',
  'tr-queue.js',
  'index.js',
];

const TRANSFORMERS_IMPORT_RE = /^import \* as Transformers from '\.\.\/libs\/transformers\.min\.js\?v=\d+';\s*$/m;

function bundleOffscreen(version) {
  const parts = [];
  const topLevelNames = new Map(); // 顶层名 → 所属模块（单文件时代共享同一作用域，拆分后也不允许重名）

  for (const f of ORDER) {
    const file = path.join(SRC_OFFSCREEN, f);
    if (!fs.existsSync(file)) throw new Error(`缺少引擎模块: src/offscreen/${f}`);
    let src = fs.readFileSync(file, 'utf8');

    if (f === 'engine-env.js') {
      // transformers 引入是产物中唯一保留的外部引入（在打包结果里指向版本化文件名）
      if (!TRANSFORMERS_IMPORT_RE.test(src)) {
        throw new Error('engine-env.js 的 transformers 引入写法与打包器不匹配（应保持单行 import，路径 ../libs/transformers.min.js?v=N）');
      }
      src = src.replace(
        TRANSFORMERS_IMPORT_RE,
        `import * as Transformers from '../libs/transformers.v${version}.min.js';`
      );
    } else {
      src = src.replace(/^import[^\n]*$/gm, ''); // 模块间引入直接剥除：拼接后共享同一作用域
    }
    src = src.replace(/^export[ \t]+(?=(?:async[ \t]+)?function\b|(?:const|let|var)\b)/gm, '');

    for (const m of src.matchAll(/^(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)/gm)) {
      const prev = topLevelNames.get(m[1]);
      if (prev) throw new Error(`顶层函数重名: ${m[1]}（${prev} 与 ${f}）`);
      topLevelNames.set(m[1], f);
    }
    for (const m of src.matchAll(/^(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm)) {
      const prev = topLevelNames.get(m[1]);
      if (prev) throw new Error(`顶层声明重名: ${m[1]}（${prev} 与 ${f}）`);
      topLevelNames.set(m[1], f);
    }

    parts.push(`// ===== ${f} =====\n` + src.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
  }

  let bundle = parts.join('\n');

  // worklet 同样用版本化文件名（Chrome 对扩展资源缓存顽固，物理改名是已验证的规避手段）
  bundle = bundle.split('offscreen/worklet-processor.js?v=5').join(`offscreen/worklet-processor.v${version}.js`);
  if (bundle.includes('worklet-processor.js?v=5')) throw new Error('worklet 引用未完成版本化替换');

  // 产物中不允许残留模块间 import（engine-env 的 transformers 引入除外）
  const strayImports = bundle.match(/^import[^\n]*$/gm) || [];
  if (strayImports.length !== 1 || !strayImports[0].includes(`transformers.v${version}.min.js`)) {
    throw new Error('打包产物存在未处理的 import：' + strayImports.join(' ; '));
  }
  return bundle;
}

module.exports = { bundleOffscreen, ORDER };
