// 版本化构建：源码 → 物理版本化产物（offscreen.vN.js / engine.vN.html / transformers.vN.min.js /
// worklet-processor.vN.js + engine-version.json 索引）。
//
// 用途：Chrome 对 chrome-extension:// 资源有顽固缓存，扩展重载后仍可能拿到旧 JS；
// 物理改名文件是已验证的规避手段。background 启动时读取 engine-version.json 选择最新入口。
//
// 用法：
//   npm run version        # 用当前版本号生成（tools/version.json）
//   npm run bump           # 版本号 +1 后生成（每次修改引擎源码后运行）
//   node make-versioned.cjs --bump   等价于 npm run bump

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { bundleOffscreen } = require('./lib/bundle-offscreen.cjs');

const ROOT = path.join(__dirname, '..');
const SRC_OFFSCREEN = path.join(ROOT, 'src', 'offscreen');
const SRC_LIBS = path.join(ROOT, 'src', 'libs');
const VERSION_FILE = path.join(__dirname, 'version.json');

function readVersion() {
  return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')).version;
}

function writeVersion(v) {
  fs.writeFileSync(VERSION_FILE, JSON.stringify({ version: v }, null, 2) + '\n');
}

// 清理所有旧版本化产物（只保留当前版本），避免历史版本堆积
function pruneOldArtifacts(keep) {
  const keepers = new Set([
    `offscreen.v${keep}.js`,
    `engine.v${keep}.html`,
    `worklet-processor.v${keep}.js`,
  ]);
  for (const f of fs.readdirSync(SRC_OFFSCREEN)) {
    if (/^(offscreen|engine|worklet-processor)\.v\d+\.(js|html)$/.test(f) && !keepers.has(f)) {
      fs.unlinkSync(path.join(SRC_OFFSCREEN, f));
      console.log('清理旧产物:', f);
    }
  }
  for (const f of fs.readdirSync(SRC_LIBS)) {
    if (/^transformers\.v\d+\.min\.js$/.test(f) && f !== `transformers.v${keep}.min.js`) {
      fs.unlinkSync(path.join(SRC_LIBS, f));
      console.log('清理旧产物:', f);
    }
  }
}

function buildVersioned() {
  const v = readVersion();
  const transformers = path.join(SRC_LIBS, 'transformers.min.js');
  if (!fs.existsSync(transformers)) {
    throw new Error('src/libs/transformers.min.js 不存在：请先运行 npm run get-libs');
  }
  const libSrc = fs.readFileSync(transformers, 'utf8');
  // 补丁标记校验：引擎页在 offscreen/ 子目录下，运行库必须解析到 ../libs/（见 tools/get-libs.mjs）
  if (!libSrc.includes('new URL("../libs/",document.baseURI)')) {
    throw new Error('transformers.min.js 未打本地化补丁或补丁路径不是 ../libs/：请运行 npm run get-libs');
  }

  // 1) 模块打包 + 语法校验（ESM 用 .mjs 副本走 node --check）
  const bundle = bundleOffscreen(v);
  const checkTmp = path.join(SRC_OFFSCREEN, `.bundle-check.v${v}.mjs`);
  fs.writeFileSync(checkTmp, bundle);
  try {
    execSync(`node --check "${checkTmp}"`, { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(checkTmp);
  }
  fs.writeFileSync(path.join(SRC_OFFSCREEN, `offscreen.v${v}.js`), bundle);

  // 2) worklet / transformers / 引擎页的版本化副本
  fs.copyFileSync(path.join(SRC_OFFSCREEN, 'worklet-processor.js'), path.join(SRC_OFFSCREEN, `worklet-processor.v${v}.js`));
  fs.copyFileSync(transformers, path.join(SRC_LIBS, `transformers.v${v}.min.js`));
  const html = fs.readFileSync(path.join(SRC_OFFSCREEN, 'engine.html'), 'utf8');
  if (!html.includes('index.js?v=5')) throw new Error('engine.html 中找不到入口脚本 index.js?v=5');
  fs.writeFileSync(path.join(SRC_OFFSCREEN, `engine.v${v}.html`), html.replace('index.js?v=5', `offscreen.v${v}.js`));

  // 3) 入口索引：background 启动时探测此文件选择版本化引擎页
  fs.writeFileSync(path.join(SRC_OFFSCREEN, 'engine-version.json'), JSON.stringify({ html: `engine.v${v}.html`, version: v }, null, 2) + '\n');

  pruneOldArtifacts(v);
  console.log(`版本化产物已生成：engine.v${v}.html / offscreen.v${v}.js / worklet-processor.v${v}.js / transformers.v${v}.min.js`);
  return v;
}

function cli() {
  let v = readVersion();
  if (process.argv.includes('--bump')) {
    v += 1;
    writeVersion(v);
    console.log('版本号已递增 → v' + v);
  }
  buildVersioned();
}

module.exports = { buildVersioned, readVersion };

if (require.main === module) cli();
