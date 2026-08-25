// 补齐 src/libs/（推理运行库三件套）并打本地化补丁。
//
// 三件套：
//   transformers.min.js                    transformers.js 3.8.1（已含 whisper/pipe API）
//   ort-wasm-simd-threaded.jsep.mjs        onnxruntime-web 的 WASM 加载器（transformers 按模块表动态 import）
//   ort-wasm-simd-threaded.jsep.wasm       ONNX 推理内核（WebGPU jsep 版）
//
// 补丁 1（关键）：transformers.min.js 内置的 jsdelivr CDN 默认路径在 MV3 扩展页面会被 CSP 拦截，
//   必须替换为基于 document.baseURI 的本地 ../libs/ 绝对路径（引擎页在 src/offscreen/ 下，
//   因此是 ../libs/；旧版项目的 "libs/" 补丁会被自动升级）。
// 补丁 2：修复 transformers.js 3.8.1 的偶发崩溃——文件获取编排器的 options 参数没有默认值，
//   遇到可选文件 404 时读 r.local_files_only 会抛 TypeError，改为可选链。
//
// 用法：
//   npm run get-libs               # 下载三件套 + 打补丁
//   node tools/get-libs.mjs --patch-only   # 手动替换 transformers.min.js 后仅重新打补丁

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBS = path.join(ROOT, 'src', 'libs');
const BASE = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist';
const FILES = ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs'];

const PATCH1_NEW = 'new URL("../libs/",document.baseURI)'; // 引擎页在 offscreen/ 子目录 → ../libs/
const PATCH1_OLD = 'new URL("libs/",document.baseURI)';    // 旧版项目布局的补丁（自动升级）
const PATCH1_CDN_RE = /`https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@[^`]*`/g;

async function download() {
  fs.mkdirSync(LIBS, { recursive: true });
  for (const f of FILES) {
    const out = path.join(LIBS, f);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      console.log('已存在，跳过下载:', f);
      continue;
    }
    console.log('下载:', BASE + '/' + f);
    const res = await fetch(BASE + '/' + f);
    if (!res.ok) throw new Error(`下载失败 ${res.status}: ${f}（检查网络，或手动从 ${BASE}/ 下载放到 src/libs/）`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(out, buf);
    console.log(`  完成 (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }
}

function patchTransformers() {
  const target = path.join(LIBS, 'transformers.min.js');
  let src = fs.readFileSync(target, 'utf8');

  // 补丁 1：CDN 模板 → 本地 ../libs/（或升级旧布局的 libs/ 补丁）
  if (src.includes(PATCH1_NEW)) {
    console.log('补丁 1 已是最新（../libs/），跳过');
  } else if (src.includes(PATCH1_OLD)) {
    src = src.split(PATCH1_OLD).join(PATCH1_NEW);
    console.log('补丁 1 已从旧布局（libs/）升级为新布局（../libs/）');
  } else {
    const matches = src.match(PATCH1_CDN_RE) || [];
    if (matches.length !== 1) {
      throw new Error('找到 ' + matches.length + ' 处 CDN 模板，需人工确认: ' + matches.join(' , '));
    }
    src = src.replace(PATCH1_CDN_RE, `(typeof document!=="undefined"?${PATCH1_NEW}.href:"./")`);
    console.log('补丁 1 完成：运行库路径本地化（../libs/）');
  }
  fs.writeFileSync(target, src);

  // 补丁 2：local_files_only 可选链
  src = fs.readFileSync(target, 'utf8');
  if (src.includes('r?.local_files_only')) {
    console.log('补丁 2 已存在，跳过');
  } else {
    const n = (src.match(/r\.local_files_only/g) || []).length;
    src = src.split('r.local_files_only').join('r?.local_files_only');
    fs.writeFileSync(target, src);
    console.log(`补丁 2 完成：已修复 ${n} 处 local_files_only 读取`);
  }

  if (!fs.readFileSync(target, 'utf8').includes(PATCH1_NEW)) throw new Error('补丁写入校验失败');
}

download()
  .catch((e) => {
    if (process.argv.includes('--patch-only')) { console.log('跳过下载（--patch-only）'); return; }
    throw e;
  })
  .then(patchTransformers)
  .then(() => {
    console.log('libs 目录就绪。加载扩展前无需其他步骤。');
  })
  .catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
