// 本地 Whisper 识别管线：transformers.js + onnxruntime-web（WebGPU 优先，WASM 回退）。
// 职责：模型方案组合（GPU 量化优先）、下载源探测（官方/国内镜像）、停滞看门狗、
// 扩展目录 models/ 本地权重直读、管线对象工厂 { asr, options, device, name }。

import { pipeline, env, ENGINE_VERSION } from './engine-env.js';
import { postStatus } from './bus.js';

env.allowLocalModels = false;
// 本地模型目录探测缓存（repo → 是否存在）：扩展目录 models/<org>/<repo>/ 放有权重时
// 从磁盘直读——免下载、随扩展文件夹存放在任意盘符（见 tools/download-model.ps1）
const localProbe = new Map();
// 注意：不要手动设置 env.backends.onnx.wasm.wasmPaths。
// onnxruntime 运行库路径由补丁后的引擎默认值提供（基于 document.baseURI 解析到 libs/ 目录），
// 该方案已在真实浏览器中端到端验证可用；额外的对象形式覆盖曾在扩展环境中引发异常。

// 模型权重下载源：官方 + 国内镜像，运行时自动探测选择可用的
const HF_HOSTS = ['https://huggingface.co', 'https://hf-mirror.com'];

// 依次尝试多个模型方案：优先 WebGPU + 量化权重，失败则回退到 WASM。
// 注意：非时间戳模型优先——时间戳模型每个词都要额外解码时间戳，明显拖慢速度且我们用不到
function buildCombos(modelKey) {
  const combos = [];
  // turbo = whisper-large-v3-turbo（OpenAI 官方蒸馏：精度接近 large-v3、速度接近 base）
  const main = modelKey === 'turbo' ? 'onnx-community/whisper-large-v3-turbo' : `onnx-community/whisper-${modelKey}`;
  const fallback = modelKey === 'turbo' ? 'onnx-community/whisper-large-v3-turbo' : `Xenova/whisper-${modelKey}`;
  if (navigator.gpu) {
    combos.push({ repo: main, device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'fp16' } });
    combos.push({ repo: main, device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' } });
    combos.push({ repo: main, device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } });
    combos.push({ repo: main, device: 'webgpu', dtype: 'fp32' });
  }
  combos.push({ repo: fallback, device: 'wasm', dtype: 'q8' });
  if (modelKey !== 'turbo') combos.push({ repo: main, device: 'wasm', dtype: 'q8' });
  return combos;
}

// 用 Range 小段 GET 探测能否真正下载模型权重（会跟随跳转到文件 CDN，比 HEAD 更接近真实下载链路）
async function canServeWeights(host, modelKey) {
  const probeRepo = modelKey === 'turbo' ? 'onnx-community/whisper-large-v3-turbo' : `onnx-community/whisper-${modelKey}_timestamped`;
  const url = `${host}/${probeRepo}/resolve/main/onnx/decoder_model_merged_q4.onnx`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' }, signal: controller.signal });
    return res.ok;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// 返回按优先级排序的下载源：弹窗里强制指定的优先；自动模式下上次成功的优先，
// 并用真实下载探测过滤掉"主页能通但文件 CDN 不通"的源；全部不通时仍按原顺序硬试
async function candidateHosts(cfg) {
  const forced = cfg && cfg.dlSource;
  if (forced === 'direct') return ['https://huggingface.co'];
  if (forced === 'mirror') return ['https://hf-mirror.com'];

  let hfHost = '';
  try {
    if (chrome.storage && chrome.storage.local) {
      ({ hfHost } = await chrome.storage.local.get({ hfHost: '' }));
    }
  } catch (e) { /* offscreen 文档可能没有 storage API */ }
  const list = [];
  if (hfHost) list.push(hfHost);
  for (const h of HF_HOSTS) if (!list.includes(h)) list.push(h);
  const results = await Promise.all(list.map(async (h) => [h, await canServeWeights(h, modelKeyOf(cfg))]));
  const ok = results.filter(([, reach]) => reach).map(([h]) => h);
  const bad = results.filter(([, reach]) => !reach).map(([h]) => h);
  return ok.length ? ok : bad;
}

function modelKeyOf(cfg) {
  return (cfg && cfg.model) || 'base';
}

// 停滞看门狗：超过 150 秒没有任何下载/初始化活动就放弃当前方案，切换下一个。
// 覆盖两类卡死：文件 CDN 不通导致 fetch 挂起、WebGPU 首次会话初始化慢（部分显卡驱动上 base 模型可能要 1-2 分钟）
function withStallWatchdog(makePromise, timeoutMs = 150000) {
  return new Promise((resolve, reject) => {
    let lastActivity = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastActivity > timeoutMs) {
        clearInterval(timer);
        reject(new Error('该方案长时间无进展，已跳过'));
      }
    }, 10000);
    const tick = () => { lastActivity = Date.now(); };
    makePromise(tick).then(
      (v) => { clearInterval(timer); resolve(v); },
      (e) => { clearInterval(timer); reject(e); }
    );
  });
}

const fileNameOf = (f) => String(f || '').split('/').pop();

const recentErrors = []; // 各模型方案的失败详情，最终透出到面板便于排查

// 每次会话开始时清空失败详情（编排层调用）
export function resetPipelineErrors() {
  recentErrors.length = 0;
}

// 创建一条识别管线：依次尝试多方案（WebGPU 量化权重优先，失败回退 WASM）。
// 返回 { asr, options, device, name }；全部失败返回 null。
// quiet=true 供第二管线后台加载使用：不打断状态栏、失败不打扰用户。
export async function createPipeline(cfg, modelKey, forceWasm = false, quiet = false) {
  const hosts = await candidateHosts(cfg);
  let lastErr = null;

  for (const host of hosts) {
    try { env.remoteHost = host; } catch (e) { /* 旧版本字段名不同则忽略 */ }
    const viaMirror = host.includes('hf-mirror');
    const combos = buildCombos(modelKey).filter((c) => !forceWasm || c.device === 'wasm');

    for (const combo of combos) {
      try {
        // 本地模型优先：该方案 repo 在扩展 models/ 目录下有权重（以 config.json 存在为准）时
        // 启用本地直读；个别 dtype 文件缺失仍会自动回落远程补齐，不影响后续方案回退
        let localHit = localProbe.get(combo.repo);
        if (localHit === undefined) {
          localHit = await fetch(chrome.runtime.getURL('models/' + combo.repo + '/config.json'), { cache: 'no-store' })
            .then((r) => r.ok).catch(() => false);
          localProbe.set(combo.repo, localHit);
        }
        env.allowLocalModels = localHit;
        if (localHit) { try { env.localModelPath = chrome.runtime.getURL('models/'); } catch (e) { /* 旧版本无此字段 */ } }
        if (!quiet) postStatus(`加载模型 ${combo.repo}（${combo.device === 'webgpu' ? 'GPU 加速' : 'CPU'}${localHit ? '·本地权重' : viaMirror ? '，国内镜像' : ''}）…`);
        const inst = await withStallWatchdog((tick) => pipeline('automatic-speech-recognition', combo.repo, {
          device: combo.device,
          dtype: combo.dtype,
          progress_callback: (info) => {
            tick();
            if (!quiet && info && info.status === 'progress' && info.total) {
              const pct = Math.min(100, Math.round((info.loaded / info.total) * 100));
              postStatus(`下载模型 ${fileNameOf(info.file)} ${pct}%`);
            }
          },
        }));
        // offscreen 文档没有 chrome.storage API（只有 runtime 消息等），必须防护，绝不能拖垮已成功的方案
        try { if (chrome.storage && chrome.storage.local) chrome.storage.local.set({ hfHost: host }); } catch (e) { /* 忽略 */ }
        return { asr: inst, options: { task: 'transcribe' }, device: combo.device, name: combo.repo.split('/').pop() };
      } catch (e) {
        lastErr = e;
        const msg = ((e && e.message) || e || '未知错误') + '';
        const stack = String((e && e.stack) || '').split('\n').slice(0, 5).join(' ⏎ ');
        const detail = `${host} ${combo.repo} ${combo.device}: ${msg}${stack ? ' @ ' + stack : ''}`;
        recentErrors.push(detail);
        if (recentErrors.length > 6) recentErrors.shift();
        console.warn('模型方案加载失败：', detail);
      }
    }
  }

  if (!quiet) {
    postStatus(
      '',
      `模型加载失败（引擎 ${ENGINE_VERSION}）：` + ((lastErr && lastErr.message) || lastErr || '未知错误') +
      (recentErrors.length ? '。各方案错误：' + recentErrors.join('；') : '') +
      '。可尝试把"模型下载源"切换为"国内镜像"后重试'
    );
  }
  return null;
}
