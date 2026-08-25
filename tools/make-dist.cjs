// 上线打包流水线：版本化产物 → terser 压缩混淆 → dist/ → release/zip
// 用法：npm run dist
// 产物：
//   dist/                        可直接"加载已解压的扩展程序"或上传 Chrome Web Store
//   release/real-time-<版本>.zip  商店上传包
// 注意：dist 不包含 models/（本地模型权重，可选）；上传商店默认走首次运行时下载

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { minify } = require('terser');
const { buildVersioned, readVersion } = require('./make-versioned.cjs');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const RELEASE = path.join(ROOT, 'release');

// 压缩配置：mangle 混淆局部/顶层符号（代码保护），保留字符串字面量与全局属性名；
// pure_funcs 剔除 console.log/info/debug（保留 warn/error 供售后诊断）
const TERSER_COMMON = {
  compress: { passes: 2, pure_funcs: ['console.log', 'console.info', 'console.debug'] },
  format: { comments: false },
};

async function minifyTo(src, dst, opts) {
  const code = fs.readFileSync(path.join(ROOT, src), 'utf8');
  const out = await minify(code, opts);
  fs.mkdirSync(path.dirname(path.join(DIST, dst)), { recursive: true });
  fs.writeFileSync(path.join(DIST, dst), out.code);
}

function assertFile(rel) {
  const p = path.join(DIST, rel);
  if (!fs.existsSync(p)) throw new Error('dist 缺少文件: ' + rel);
  return p;
}

async function main() {
  // 0) 确保版本化产物存在（源码模式与发布产物共用同一套版本化文件名），并重建输出目录
  const V = readVersion();
  buildVersioned();
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.rmSync(RELEASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'libs'), { recursive: true });
  fs.mkdirSync(RELEASE, { recursive: true });

  // 1) 混淆压缩自有 JS（offscreen/worklet 是 ES 模块）
  const jobs = [
    ['src/background/background.js', 'background/background.js', { ...TERSER_COMMON, mangle: { toplevel: true } }],
    ['src/content/content.js', 'content/content.js', { ...TERSER_COMMON, mangle: { toplevel: true } }],
    ['src/popup/popup.js', 'popup/popup.js', { ...TERSER_COMMON, mangle: { toplevel: true } }],
    [`src/offscreen/offscreen.v${V}.js`, `offscreen/offscreen.v${V}.js`, { ...TERSER_COMMON, module: true, mangle: { toplevel: true } }],
    [`src/offscreen/worklet-processor.v${V}.js`, `offscreen/worklet-processor.v${V}.js`, { ...TERSER_COMMON, module: true }],
  ];
  for (const [src, dst, opts] of jobs) {
    const before = fs.statSync(path.join(ROOT, src)).size;
    await minifyTo(src, dst, opts);
    const after = fs.statSync(path.join(DIST, dst)).size;
    console.log(`压缩 ${src}: ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB`);
  }

  // 2) 原样复制：已压缩的 transformers、ORT 推理运行时、HTML/CSS、清单、图标、用户说明
  fs.copyFileSync(path.join(SRC, 'libs', `transformers.v${V}.min.js`), path.join(DIST, 'libs', `transformers.v${V}.min.js`));
  // ORT WASM 运行时（jsep 内核 + .mjs 加载器）：transformers 运行时按 wasmPaths 动态 import，
  // 漏掉即 "Failed to fetch dynamically imported module .../ort-wasm-simd-threaded.jsep.mjs"
  const ortFiles = fs.readdirSync(path.join(SRC, 'libs')).filter((f) => /^ort-/.test(f));
  if (!ortFiles.length) throw new Error('src/libs/ 缺少 ORT 运行时文件（ort-*.mjs/.wasm）：请先运行 npm run get-libs');
  for (const f of ortFiles) fs.copyFileSync(path.join(SRC, 'libs', f), path.join(DIST, 'libs', f));
  fs.copyFileSync(path.join(SRC, 'offscreen', `engine.v${V}.html`), path.join(DIST, 'offscreen', `engine.v${V}.html`));
  // 入口索引必须随包：background 靠它选择版本化引擎页（缺失会回退到源码版 engine.html，而 dist 里没有该文件）
  fs.copyFileSync(path.join(SRC, 'offscreen', 'engine-version.json'), path.join(DIST, 'offscreen', 'engine-version.json'));
  fs.copyFileSync(path.join(SRC, 'popup', 'popup.html'), path.join(DIST, 'popup', 'popup.html'));
  fs.copyFileSync(path.join(SRC, 'popup', 'popup.css'), path.join(DIST, 'popup', 'popup.css'));
  fs.copyFileSync(path.join(SRC, 'content', 'content.css'), path.join(DIST, 'content', 'content.css'));
  fs.copyFileSync(path.join(SRC, 'manifest.json'), path.join(DIST, 'manifest.json'));
  fs.mkdirSync(path.join(DIST, 'icons'), { recursive: true });
  for (const f of fs.readdirSync(path.join(SRC, 'icons'))) {
    fs.copyFileSync(path.join(SRC, 'icons', f), path.join(DIST, 'icons', f));
  }
  // 包装说明：用面向用户的版本（docs/user-guide.md），不带开发/测试流程信息
  fs.copyFileSync(path.join(ROOT, 'docs', 'user-guide.md'), path.join(DIST, 'README.md'));

  // 3) 引用链校验：manifest 声明的每个文件都必须存在于 dist
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  const refs = new Set();
  refs.add(manifest.background.service_worker);
  refs.add(manifest.action.default_popup);
  for (const i of Object.values(manifest.icons || {})) refs.add(i);
  for (const i of Object.values(manifest.action.default_icon || {})) refs.add(i);
  for (const cs of manifest.content_scripts || []) { for (const j of cs.js) refs.add(j); for (const c of cs.css) refs.add(c); }
  for (const r of refs) assertFile(r);
  // popup 页的本地资源（CSS/JS）
  const popupHtml = fs.readFileSync(path.join(DIST, 'popup', 'popup.html'), 'utf8');
  for (const m of popupHtml.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const v = m[1];
    if (/^(https?:|chrome-extension:|#)/.test(v)) continue;
    assertFile(path.join('popup', v));
  }
  // 引擎链：engine-version.json → engine.html → offscreen bundle → transformers / worklet
  const engineIndex = JSON.parse(fs.readFileSync(path.join(DIST, 'offscreen', 'engine-version.json'), 'utf8'));
  if (engineIndex.html !== `engine.v${V}.html`) throw new Error('engine-version.json 与产物版本不一致');
  assertFile(path.join('offscreen', engineIndex.html));
  const engineHtml = fs.readFileSync(path.join(DIST, 'offscreen', `engine.v${V}.html`), 'utf8');
  if (!engineHtml.includes(`offscreen.v${V}.js`)) throw new Error('engine.html 未引用 offscreen');
  const offDist = fs.readFileSync(path.join(DIST, 'offscreen', `offscreen.v${V}.js`), 'utf8');
  if (!offDist.includes(`transformers.v${V}.min.js`)) throw new Error('offscreen 未引用 transformers');
  if (!offDist.includes(`worklet-processor.v${V}.js`)) throw new Error('offscreen 未引用 worklet');
  // ORT 运行时核对：transformers 模块表里所有 ort-*.mjs/.wasm 动态加载目标都必须在 dist/libs
  const libSrc = fs.readFileSync(path.join(DIST, 'libs', `transformers.v${V}.min.js`), 'utf8');
  const ortNames = [...new Set([...libSrc.matchAll(/ort-wasm[A-Za-z0-9.-]*?\.(?:mjs|wasm)/g)].map((m) => m[0]))];
  const ortMissing = ortNames.filter((n) => !fs.existsSync(path.join(DIST, 'libs', n)));
  if (ortMissing.length) throw new Error('dist/libs 缺少 ORT 运行时: ' + ortMissing.join(', '));
  console.log('ORT 运行时核对通过:', ortNames.join(', '));
  console.log('引用链校验通过');

  // 4) 语法校验（模块文件用 .mjs 副本走 node --check，递归子目录）
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  for (const f of walk(DIST).filter((x) => x.endsWith('.js'))) {
    const rel = path.relative(DIST, f);
    const tmp = path.join(DIST, '.' + rel + '.check.mjs');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.copyFileSync(f, tmp);
    try {
      execSync(`node --check "${tmp}"`, { stdio: 'pipe' });
    } finally {
      fs.unlinkSync(tmp);
    }
  }
  console.log('语法校验通过');

  // 5) 打 zip（商店上传包）
  const zipName = `real-time-${manifest.version}.zip`;
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${DIST.replace(/'/g, "''")}\\*' -DestinationPath '${path.join(RELEASE, zipName).replace(/'/g, "''")}' -Force"`, { stdio: 'pipe' });
  const zipSize = fs.statSync(path.join(RELEASE, zipName)).size / 1024 / 1024;
  console.log(`打包完成: release/${zipName} (${zipSize.toFixed(1)} MB)`);

  if (fs.existsSync(path.join(SRC, 'models'))) {
    console.log('提示: dist/ 不含 models/（本地模型权重）。离线分发时可自行复制 src/models/ 到 dist/。');
  }
}

main().catch((e) => { console.error('打包失败:', e.message); process.exit(1); });
