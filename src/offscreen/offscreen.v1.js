// ===== engine-env.js =====
// 引擎环境：transformers.js 的唯一引入入口 + 引擎版本号。
// 所有需要 pipeline/env 的模块一律从这里 import，
// 打包时（tools/make-versioned.cjs）才能把唯一的 transformers 引入保留在产物顶部并替换为版本化文件名。

import * as Transformers from '../libs/transformers.v1.min.js';
const pipeline = Transformers.pipeline;
const env = Transformers.env;

// 版本标记：面板状态会带上它，用于确认浏览器运行的是最新代码（排除模块缓存）
const ENGINE_VERSION = 'v1';

// ===== bus.js =====
// 消息总线：引擎各模块共用的状态上报通道。
// bannerStatus 记录当前"运行中"横幅文案，临时警告（8 秒后恢复）都从这里取回。

let bannerStatus = '';

function getBannerStatus() {
  return bannerStatus;
}

function post(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* service worker 唤醒中 */ });
}

function postStatus(status, error) {
  post({ type: 'offscreen-status', status: status || '', error: error || '' });
}

// 运行横幅：除展示外记住内容，供临时警告结束后恢复
function postBanner(status) {
  bannerStatus = status;
  postStatus(status);
}

// ===== asr-clean.js =====
// 识别文本清洗：Whisper/云端原始输出 → 可上屏的字幕文本。
// 职责：断句杂符清理、纯音乐/掌声噪声拦截、静音段幻觉黑名单、重复幻觉去重（副歌放行）、
// 以及"有声无字"诊断（段内响度达标但识别为空——识别层限制，需与翻译问题区分开）。

// 采样 RMS（抽样计算，诊断用）
function rmsOf(samples) {
  let s = 0;
  const step = 8;
  let n = 0;
  for (let i = 0; i < samples.length; i += step) { s += samples[i] * samples[i]; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

// onLoudEmpty：连续多段"有声音但识别为空"时的告警回调（编排层注入，负责文案与恢复横幅）
function createAsrCleaner(onLoudEmpty) {
  const recentTexts = []; // 最近的识别文本，用于抑制静音段的幻觉重复
  let emptyLoudStreak = 0;
  let emptyLoudWarnAt = 0;

  // 清洗 Whisper 输出的断句杂符与控制字符（|| | _ 等），避免透传到字幕和译文；
  // 噪声/幻觉段返回空串
  function clean(out) {
    const text = String((out && out.text) || '').replace(/[|_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return '';

    // 过滤纯音乐/音效/掌声等噪声标记（Whisper 对 BGM 的典型输出），不产生垃圾字幕行
    const noiseCore = text.replace(/[（(【[\[\])）】\s.。、，！？…♪]/g, '');
    if (!noiseCore || /^(音楽|音乐|拍手|効果音|效果音|拍手音|BGM|♪+)$/.test(noiseCore)) return '';

    // Whisper 对静音/BGM 的著名幻觉（"ご視聴ありがとうございました 感谢观看""请订阅"等）：直接拦截
    if (/(ご?視聴.{0,12}ありがとう|最後までご視聴|チャンネル登録.{0,8}お願い|高評価.{0,8}お願い|字幕.{0,6}(by|制作)|thank you for watching|please subscribe|subtitles? by)/i.test(text)) return '';

    // 重复幻觉过滤：短句比对最近 4 条（幻觉句常与真实语句交替出现）；
    // 长句只拦紧邻重复——歌词副歌会隔几行逐字重现，那是真唱词不是幻觉，拦太狠会吃掉整段副歌
    const dupWin = text.length <= 12 ? 4 : 1;
    if (recentTexts.slice(-dupWin).includes(text)) return '';
    recentTexts.push(text);
    if (recentTexts.length > 10) recentTexts.shift();

    return text;
  }

  // 有声无字诊断：连续 ≥3 段响度达标却识别为空时告警一次（2 分钟冷却）。
  // 这是识别模型对这类音频（游戏语音/BGM/唱腔混杂）不敏感，不是翻译问题
  function note(text, samples) {
    const loud = rmsOf(samples) > 0.008;
    if (!text && loud) {
      emptyLoudStreak++;
      if (emptyLoudStreak >= 3 && Date.now() - emptyLoudWarnAt > 120000) {
        emptyLoudWarnAt = Date.now();
        if (onLoudEmpty) onLoudEmpty();
      }
    } else {
      emptyLoudStreak = 0;
    }
  }

  return { clean, note };
}

// ===== asr-cloud.js =====
// 云端识别：OpenAI 风格 /audio/transcriptions（智谱 glm-asr 等）。
// LLM 级抗噪与上下文理解，对 BGM/游戏音效混杂的直播音频明显更准；接口限制 30s/段，与分段长度天然匹配。

// 智谱端点的模型名大小写敏感且全小写：统一归一，避免"模型不存在"
function normalizeZhipuModel(name, root) {
  const n = String(name || '').trim();
  return /bigmodel|zhipu/i.test(String(root || '')) ? n.toLowerCase() : n;
}

// Float32 16kHz 单声道 → 16bit PCM WAV Blob（转写接口的标准输入格式）
function encodeWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function cloudTranscribe(cfg, samples) {
  const key = String(cfg.llmKey || '').trim();
  if (!key) throw new Error('云端识别需要 API Key（在弹窗"翻译服务→大模型 API"里配置）');
  // Base URL 兼容三种填法：裸根地址 / 带 /chat/completions 的完整端点 / 其他 OpenAI 兼容服务
  const base = String(cfg.llmBaseUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const root = base || 'https://open.bigmodel.cn/api/paas/v4';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000); // 上传+转写，网络慢时放宽
  try {
    const fd = new FormData();
    fd.append('model', normalizeZhipuModel(cfg.asrCloudModel || 'glm-asr-2512', root));
    fd.append('file', encodeWav(samples), 'audio.wav');
    const res = await fetch(root + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },
      body: fd,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('云端识别 HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
    const j = await res.json();
    const text =
      (j && (j.text || j.transcript || j.result ||
        (Array.isArray(j.segments) ? j.segments.map((s) => s.text || '').join('') : ''))) || '';
    return String(text).trim();
  } finally {
    clearTimeout(timer);
  }
}

// 云端识别"管线"：与本地管线同接口（{ kind, device, name, options, asr }），
// 整套并发 worker/顺序门/延迟统计直接复用；无状态可并行
function makeCloudAsr(cfg) {
  return {
    kind: 'cloud',
    device: 'cloud',
    name: normalizeZhipuModel((cfg && cfg.asrCloudModel) || 'glm-asr-2512', cfg && cfg.llmBaseUrl),
    options: {},
    asr: async (samples) => ({ text: await cloudTranscribe(cfg, samples) }),
  };
}

// ===== asr-local.js =====
// 本地 Whisper 识别管线：transformers.js + onnxruntime-web（WebGPU 优先，WASM 回退）。
// 职责：模型方案组合（GPU 量化优先）、下载源探测（官方/国内镜像）、停滞看门狗、
// 扩展目录 models/ 本地权重直读、管线对象工厂 { asr, options, device, name }。

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
function resetPipelineErrors() {
  recentErrors.length = 0;
}

// 创建一条识别管线：依次尝试多方案（WebGPU 量化权重优先，失败回退 WASM）。
// 返回 { asr, options, device, name }；全部失败返回 null。
// quiet=true 供第二管线后台加载使用：不打断状态栏、失败不打扰用户。
async function createPipeline(cfg, modelKey, forceWasm = false, quiet = false) {
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

// ===== tr-google.js =====
// Google 免费翻译：主备双通道 + 熔断。
//
// 主接口 client=gtx（逐句对齐）按 IP 激进限流（429 + "Sorry..." 页），
// 被限流时自动切 clients5 的 dict-chrome-ex 备用接口——两者限流池相互独立。
// 记住上次成功的通道优先使用，失败换另一条（天然定期重探）。
// 两通道都失败才返回 null（外层据此熔断/打失败标记）；熔断期内直接短路不再发请求。

let googleDownUntil = 0; // 熔断截止时间（双通道全挂时停 2 分钟，避免每句挂 10s）
let googlePrefer = 0;    // 上次成功的通道下标（0=gtx 主，1=clients5 备）

function isGoogleDown() {
  return Date.now() < googleDownUntil;
}

function tripGoogleBreaker(ms) {
  googleDownUntil = Date.now() + ms;
}

function getGooglePrefer() {
  return googlePrefer;
}

async function translateGoogle(text, sl, tl, attempts = 2, timeoutMs = 10000) {
  if (isGoogleDown()) return null;
  const q = encodeURIComponent(text);
  const slv = encodeURIComponent(sl || 'auto');
  const tlv = encodeURIComponent(tl);
  const urls = [
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' + `&sl=${slv}&tl=${tlv}&q=${q}`,
    'https://clients5.google.com/translate_a/t?client=dict-chrome-ex' + `&sl=${slv}&tl=${tlv}&q=${q}`,
  ];
  const order = googlePrefer === 1 ? [1, 0] : [0, 1];
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const idx of order) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(urls[idx], { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const first = Array.isArray(data) ? data[0] : null;
        // 三种返回形态：gtx [["译","原",..],..] 逐段拼接；clients5 显式 sl ["译文"]；clients5 auto [["译文","语言"]]
        let t = null;
        if (typeof first === 'string') t = first;
        else if (Array.isArray(first) && typeof first[0] === 'string') t = first[0];
        else if (Array.isArray(first) && Array.isArray(first[0])) t = first.map((seg) => (seg && seg[0]) || '').join('');
        t = String(t || '').trim();
        if (t) {
          googlePrefer = idx;
          return t;
        }
        throw new Error('空译文');
      } catch (e) {
        clearTimeout(timer); // 本通道失败：换下一通道
      }
    }
    if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

// 双通道全挂时的统一提示（由翻译调度层调用）
function announceGoogleDown() {
  tripGoogleBreaker(120000);
  postStatus('⚠ Google 免费翻译主/备通道均不可用（接口限流或网络不通）：已暂停 2 分钟，建议切换"大模型翻译"');
}

// ===== tr-deepl.js =====
// DeepL 翻译：官方 API，日中质量高，需用户自己的 Key（free 版以 :fx 结尾）。

async function translateDeepL(cfg, text, tl) {
  const key = String(cfg.deeplKey || '').trim();
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(host + '/v2/translate', {
      method: 'POST',
      headers: { Authorization: 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: [text], target_lang: String(tl).startsWith('zh') ? 'ZH' : String(tl).toUpperCase() }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('DeepL HTTP ' + res.status);
    const data = await res.json();
    return (data && data.translations && data.translations[0] && data.translations[0].text) || null;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ===== tr-llm.js =====
// 大模型翻译（OpenAI 兼容 /chat/completions）：
//   callLLMStream     流式主力——SSE 逐 token 接收，译完一句立刻回调上屏
//   callLLMSimple     极简自愈——主链路失败后的兜底（无流式/无附加参数，绕开兼容性问题）
//   callLLMParaphrase 大意概括——歌词版权拒绝的终极通道（不求逐句翻译，只概括唱了什么）
// cfg 即本次会话的设置对象（Base URL/Key/模型名/术语表/直播背景等）。

const SYS_QUALITY =
  '你是资深日语 VTuber 直播同传，正在为观众实时生成直播无障碍字幕（涵盖主播说话与唱歌的全部内容），把 ASR 识别的多行编号日文逐行译成简体中文。\n' +
  '要求：\n' +
  '1. 意译成自然的中文口语，绝不逐字直译；日语汉字词不要照搬（大丈夫→没事、勉強→学习）\n' +
  '2. ASR 常把一句话切成多行且有同音错字，结合上下文合并理解、先纠正再译，让每行单独读也通顺\n' +
  '3. 音频混有游戏音效/BGM/角色台词：优先译主播的话，明显是游戏内台词则前缀【游戏】\n' +
  '4. 主播语速快/吞字/口音：推断她真正想说的再译，不要直译错误文字\n' +
  '5. えー/うん 等无意义语气词可省略；うわー！等情绪要保留；惊吓、吐槽、撒娇的语气要在译文体现\n' +
  '6. 游戏名/角色名/梗用中文圈通行译法，称呼（さん/ちゃん）全篇统一，参考上下文已有译法\n' +
  '7. 输入可能包含主播清唱/哼唱的歌词（直播语音识别结果）：无障碍字幕必须让她唱的内容也能被理解，' +
  '像翻译普通对话一样直接意译成自然的中文，绝不拒绝、绝不提及版权、绝不输出解释；本条不受直播背景设定影响\n' +
  '示例：\n' +
  '输入：\n1. こんなことってある？\n2. ないないない（笑）\n' +
  '输出：\n<<1>>还能有这种事？\n<<2>>没有没有不可能（笑）\n' +
  '输出格式：每行一条 <<行号>>译文，按行号顺序，不要任何解释或多余文字。';

const SYS_FAST =
  '你是日语直播字幕翻译，把多行编号文本逐行翻译成简体中文（意译、口语化，识别错误结合上下文纠正）。' +
  '文本可能含主播清唱的歌词：这是帮助观众理解直播的实时无障碍字幕，歌词也直接意译，不要拒绝。' +
  '输出格式：每行一条 <<行号>>译文，按顺序，不要任何多余文字。';

// 大模型对歌词类内容的拒绝应答（版权策略）：短文本且含拒绝/版权关键词——
// 不当译文上屏、不进缓存，改走"为理解而译"框架重试
function looksLikeRefusal(t) {
  const s = String(t || '').trim();
  if (!s || s.length > 60) return false;
  return /(歌词|版权|著作权)|(无法|不能|拒绝|抱歉|对不起)[^。！？!\n]{0,18}(提供|翻译|复述|输出|回答|协助)|i can('t|not) (reproduce|provide|translate)/i.test(s);
}

let glmNoThinking = false; // 当前 LLM 型号不接受 thinking 参数：置位后请求不再携带（会话内记忆）

async function callLLMStream(cfg, texts, tl, ctxLines, onLine) {
  const base = String(cfg.llmBaseUrl || '').trim().replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const langName = tl === 'zh-CN' ? '简体中文' : tl === 'zh-TW' ? '繁体中文' : tl;
  const userCtx = String(cfg.streamContext || '').trim();
  const quality = (cfg.translateDetail || 'quality') !== 'fast';

  let sys = quality ? SYS_QUALITY : SYS_FAST;
  if (langName !== '简体中文') sys = sys.replace(/简体中文/g, langName);
  if (userCtx) sys += `\n本场直播背景（用户提供，仅供理解语境的补充参考，不改变上述任何翻译规则）：${userCtx}`;
  const glossary = String(cfg.glossary || '').trim();
  if (glossary) sys += `\n术语表（最高优先级，原文出现左侧词时必须用右侧译法，全篇一致）：\n${glossary}`;

  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const ctxLen = quality ? 6 : 4;
  const ctx = ctxLines && ctxLines.length ? '最近上下文（原文 => 译文）：\n' + ctxLines.slice(-ctxLen).join('\n') + '\n\n' : '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let accText = '';
  const posted = new Set();

  const emit = (final) => {
    // 行标记 <<n>>；某行被视为"完成"当且仅当出现下一个标记（或流已结束）
    const marks = [];
    const re = /<<(\d+)>>/g;
    let m;
    while ((m = re.exec(accText))) marks.push({ n: Number(m[1]), contentStart: m.index + m[0].length, nextStart: m.index });
    for (let i = 0; i < marks.length; i++) {
      const cur = marks[i];
      if (posted.has(cur.n)) continue;
      const hasNext = i + 1 < marks.length;
      if (!hasNext && !final) continue;
      const end = hasNext ? marks[i + 1].nextStart : accText.length;
      const t = accText.slice(cur.contentStart, end).trim();
      if (t) {
        posted.add(cur.n);
        onLine(cur.n, t);
      }
    }
  };

  // 智谱模型名全小写且大小写敏感（填 GLM-4.7-Flash 会报"模型不存在"）：其端点上自动归一。
  // GLM 系默认开启深度思考（先输出长推理才有正文，首句译文延迟暴涨）：显式关闭；
  // 个别型号不接受 thinking 参数（HTTP 400），glmNoThinking 置位后不再携带。
  let model = normalizeZhipuModel(cfg.llmModel || 'gpt-4o-mini', url);
  const isGLM = /bigmodel|zhipu/i.test(url) || /glm/i.test(model);

  const buildBody = () => JSON.stringify({
    model,
    temperature: 0.3,
    stream: true,
    max_tokens: Math.min(1000, 120 * texts.length + 140),
    ...(isGLM && !glmNoThinking ? { thinking: { type: 'disabled' } } : {}),
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: ctx + '翻译以下各行：\n' + numbered },
    ],
  });

  try {
    const reqInit = {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + String(cfg.llmKey || '').trim(), 'Content-Type': 'application/json' },
      signal: controller.signal,
    };
    let res = await fetch(url, { ...reqInit, body: buildBody() });
    if (!res.ok && res.status === 400 && isGLM && !glmNoThinking) {
      // 可能是该型号不支持 thinking 参数：去掉后重试一次，并记住（本次会话内不再携带）
      glmNoThinking = true;
      res = await fetch(url, { ...reqInit, body: buildBody() });
    }
    clearTimeout(timer);
    if (!res.ok) throw new Error('LLM HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));

    const isSSE = (res.headers.get('content-type') || '').includes('event-stream');
    if (isSSE && res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = '';
      let streamDone = false;
      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = sseBuf.indexOf('\n')) >= 0) {
          const line = sseBuf.slice(0, nl).trim();
          sseBuf = sseBuf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { streamDone = true; break; }
          try {
            const j = JSON.parse(payload);
            const delta = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
            if (delta && delta.content) accText += delta.content;
          } catch (e) { /* 半截 JSON，等下一个块 */ }
        }
        emit(false); // 每读一块就尝试上屏已完成的行
      }
    } else {
      // 服务端不支持流式：按普通响应整体解析
      const data = await res.json();
      accText = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    }
    emit(true); // 流结束：上屏所有剩余行
    if (posted.size === 0) {
      // 宽容解析：部分模型（尤其单句请求时）不按 <<行号>> 格式输出、直接给译文——
      // 单句取全文，多句按行拆分顺序对位；绝不因格式不符丢掉整批译文
      const raw = accText.trim();
      const lines = raw
        .split(/\n+/)
        .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
        .filter(Boolean);
      if (raw && texts.length === 1 && lines.length) {
        posted.add(1);
        onLine(1, lines.join(' '));
      } else if (lines.length) {
        const n = Math.min(lines.length, texts.length);
        for (let i = 0; i < n; i++) {
          posted.add(i + 1);
          onLine(i + 1, lines[i]);
        }
      } else {
        throw new Error('LLM 未返回有效译文: ' + accText.slice(0, 120));
      }
    }
  } catch (e) {
    clearTimeout(timer);
    emit(true); // 抛错前尽量把已收到的部分上屏
    throw e;
  }
}

// 极简自愈请求：主链路失败后的最后一道大模型通道——无流式、无 temperature/max_tokens/thinking、
// 无 <<行号>> 格式要求，只有一行对一行的翻译指令，最大限度绕开兼容性问题。
// 返回与 texts 对位的译文数组（缺失项为空串）；失败抛错。
async function callLLMSimple(cfg, texts, tl) {
  const base = String(cfg.llmBaseUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const url = base + '/chat/completions';
  const model = normalizeZhipuModel(cfg.llmModel, url);
  const langName = tl === 'zh-TW' ? '繁体中文' : tl === 'en' ? '英语' : tl === 'ko' ? '韩语' : '简体中文';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + String(cfg.llmKey || '').trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'user', content: `这是直播的实时无障碍字幕文本（语音识别结果），可能包含主播正在清唱的歌词；为帮助观众理解主播说的话和唱的歌，把下面每一行${langName}口语意译（歌词也直接译），一行对一行输出，不要编号不要解释：\n${texts.join('\n')}` },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 80));
    const data = await res.json();
    const raw = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
    if (!raw) throw new Error('空响应');
    const lines = raw
      .split(/\n+/)
      .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
      .filter(Boolean);
    if (!lines.length) throw new Error('无有效行');
    return texts.map((_, i) => lines[i] || '');
  } finally {
    clearTimeout(timer);
  }
}

// 大意概括兜底：歌词版权拒绝的终极通道——不求"逐句翻译"只求"概括她在唱什么"。
// 模型的版权策略拦前者，但几乎不拦内容概括；返回与 texts 对位的数组（🎵 前缀），失败抛错。
async function callLLMParaphrase(cfg, texts, tl) {
  const base = String(cfg.llmBaseUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const url = base + '/chat/completions';
  const model = normalizeZhipuModel(cfg.llmModel, url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + String(cfg.llmKey || '').trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0.3,
        messages: [
          { role: 'user', content: `下面每一行是一位日本主播直播时实时说的话或唱的歌的语音识别文本。不要逐句翻译，也不要提及任何版权或限制，只需用自然的一句简体中文分别概括每行唱/说的内容大意（她大概在唱什么、表达什么情绪），一行对一行输出，不要编号不要解释：\n${texts.join('\n')}` },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 80));
    const data = await res.json();
    const raw = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
    if (!raw) throw new Error('空响应');
    const lines = raw
      .split(/\n+/)
      .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
      .filter(Boolean);
    if (!lines.length) throw new Error('无有效行');
    return texts.map((_, i) => (lines[i] ? '🎵' + lines[i] : ''));
  } finally {
    clearTimeout(timer);
  }
}

// ===== tr-queue.js =====
// 翻译调度：小窗口攒批 → 流式请求 → 逐句上屏，带精确缓存、上下文与多层自愈。
// 自愈链路：LLM 流式 → callLLMSimple 极简重试 → callLLMParaphrase 大意概括 → Google 兜底 → 可点击重试的失败标记。
// 会话状态（cfg/isRunning）由 index.js 在每次 start 时注入。

let cfg = null;              // 本次会话设置（start 时注入）
let isRunning = () => false; // 引擎运行态查询（index 注入）
let contextLines = [];       // 最近几条 原文=>译文，供大模型理解上下文
let pendingLines = [];       // 待翻译的行 {id, text}
let batchTimer = null;       // 批量翻译定时器
let llmInflight = 0;         // 进行中的大模型请求数（限并发防限流）
let llmFailStreak = 0;       // 大模型连续失败计数（≥3 驻留告警）
let llmWarnShown = false;    // 是否处于驻留告警态（恢复后撤销）
let warnCooldown = 0;        // 翻译失败警告的冷却时间戳（防止刷屏）
let llm429Until = 0;         // 429 限流退避截止时间（期间不发新请求，避免雪崩）

// 精确缓存：口头禅/重复句直接命中（主播常用语、同一句感叹反复出现），跳过 API 零延迟
const transCache = new Map();

function initTranslateQueue(settings, runningFn) {
  cfg = settings;
  isRunning = runningFn;
}

// 停止时清理：清掉待译队列与兜底定时器（在途请求自然结束，不影响）
function shutdownTranslate() {
  pendingLines = [];
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
}

// 翻译链路失败的可视化：偶发失败短提示（8 秒后恢复横幅，60 秒冷却）；
// persistent=true（连续失败）时驻留状态栏，直到翻译恢复——绝不让用户对着满屏"…"猜原因
function warnTranslate(msg, persistent = false) {
  const now = Date.now();
  if (!persistent && now - warnCooldown < 60000) return;
  warnCooldown = now;
  const text = '⚠ 大模型翻译失败（' + String(cfg.llmModel || 'LLM') + '）：' + String(msg || '').slice(0, 90);
  if (persistent) {
    llmWarnShown = true;
    postStatus(text + '。请检查 Key 额度/限流/网络，恢复后自动继续');
  } else {
    postStatus(text + '，已临时回退 Google');
    setTimeout(() => { if (isRunning() && getBannerStatus() && !llmWarnShown) postStatus(getBannerStatus()); }, 8000);
  }
}

function pushContext(orig, trans) {
  contextLines.push(orig + ' => ' + trans);
  if (contextLines.length > 10) contextLines.shift();
}

const cachePut = (orig, trans) => {
  if (transCache.size > 150) transCache.delete(transCache.keys().next().value);
  transCache.set(orig, trans);
};

// 单句翻译（Google / DeepL / 单句 LLM 兜底）。skipContext：并行批量调用时不写上下文，由调用方按序写入
async function translateText(text, sl, tl, skipContext = false) {
  if (!text || !tl) return null;
  if (sl && sl !== 'auto' && sl === tl) return null;
  const provider = cfg.trProvider || 'google';
  let result = null;
  try {
    if (provider === 'deepl' && cfg.deeplKey) result = await translateDeepL(cfg, text, tl);
    else if (provider === 'llm' && cfg.llmBaseUrl && cfg.llmKey) result = await translateLLM([text], tl).then((r) => r && r[0]);
    else result = await translateGoogle(text, sl, tl, 2, 6000);
  } catch (e) {
    console.warn('翻译失败，回退 Google：', e);
    try { result = await translateGoogle(text, sl, tl); } catch (e2) { return null; }
  }
  if (result && !skipContext) pushContext(text, result);
  return result;
}

// 兼容单句调用路径（translateText 的 LLM 分支）
async function translateLLM(texts, tl) {
  const out = [];
  await callLLMStream(cfg, texts, tl, contextLines, (n, t) => { out[n - 1] = t; });
  return texts.map((_, i) => out[i] || '');
}

// 调度翻译：小窗口攒批（0.7 秒或满 3 句）→ 流式请求，模型每译完一句立刻上屏。
// 空闲（无在途请求）时第一句立即发出，不等攒批——降低首句延迟。
function scheduleTranslate(id, text) {
  const hit = transCache.get(text);
  if (hit) {
    post({ type: 'asr-translated', id, text: hit });
    pushContext(text, hit);
    return;
  }
  pendingLines.push({ id, text });
  if (pendingLines.length >= 3 || llmInflight === 0) {
    flushTranslationBatch();
  } else if (!batchTimer) {
    batchTimer = setTimeout(flushTranslationBatch, 700);
  }
}

async function flushTranslationBatch() {
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  if (!pendingLines.length) return;
  const provider = cfg.trProvider || 'google';

  if (provider === 'llm' && cfg.llmBaseUrl && cfg.llmKey) {
    if (Date.now() < llm429Until) {
      // 限流退避中：到点再发，避免越限越重的雪崩
      if (!batchTimer) batchTimer = setTimeout(flushTranslationBatch, Math.max(200, llm429Until - Date.now() + 100));
      return;
    }
    if (llmInflight >= 3) {
      // 并发已满：稍后再发，避免触发接口限流
      if (!batchTimer) batchTimer = setTimeout(flushTranslationBatch, 400);
      return;
    }
    // 单批最多 6 句：请求更小、首句译文更快到达；多余句子由下一次并发请求处理
    const batch = pendingLines.splice(0, 6);
    llmInflight++;
    const got = new Set();
    try {
      await callLLMStream(cfg, batch.map((b) => b.text), cfg.tgtLang, contextLines, (n, t) => {
        const item = batch[n - 1];
        if (item && !got.has(n) && t && !looksLikeRefusal(t)) {
          got.add(n);
          post({ type: 'asr-translated', id: item.id, text: t });
          pushContext(item.text, t);
          cachePut(item.text, t);
        }
      });
    } catch (e) {
      console.warn('LLM 流式翻译失败，开始自愈重试：', e && e.message);
      const msgStr = String((e && e.message) || e);
      if (/HTTP 429/.test(msgStr)) llm429Until = Date.now() + 8000; // 限流：全体退避 8 秒
      llmFailStreak++;
      // 自愈：极简请求再试一次——无流式、无附加参数、无格式要求，
      // 绕开 thinking/temperature/max_tokens/输出格式等一切兼容性问题。
      // 大模型在国内网络通常是唯一稳定可达的翻译通道，必须把它用尽
      try {
        const arr = await callLLMSimple(cfg, batch.map((b) => b.text), cfg.tgtLang);
        arr.forEach((t, i) => {
          if (t && !looksLikeRefusal(t) && !got.has(i + 1)) {
            got.add(i + 1);
            post({ type: 'asr-translated', id: batch[i].id, text: t });
            pushContext(batch[i].text, t);
            cachePut(batch[i].text, t);
          }
        });
      } catch (e2) {
        console.warn('极简重试也失败（配额/网络问题）：', e2 && e2.message);
        warnTranslate(msgStr + ' | 重试:' + (e2 && e2.message), llmFailStreak >= 3); // 连续失败时驻留告警，直到恢复
      }
    } finally {
      llmInflight--;
    }
    if (got.size) {
      // 翻译已恢复：清失败计数，撤掉驻留告警
      llmFailStreak = 0;
      if (llmWarnShown) {
        llmWarnShown = false;
        postBanner(getBannerStatus());
      }
    }
    if (pendingLines.length) flushTranslationBatch(); // 还有排队：立即发起下一批，别被重试拖住
    // 流式正常返回但部分行被拒（歌词版权策略）或缺失：换"为理解而译"框架的极简通道重试一次
    const missedIdx = [];
    batch.forEach((b, i) => { if (!got.has(i + 1)) missedIdx.push(i); });
    if (missedIdx.length) {
      try {
        const arr = await callLLMSimple(cfg, missedIdx.map((i) => batch[i].text), cfg.tgtLang);
        arr.forEach((t, k) => {
          const i = missedIdx[k];
          if (t && !looksLikeRefusal(t)) {
            got.add(i + 1);
            post({ type: 'asr-translated', id: batch[i].id, text: t });
            pushContext(batch[i].text, t);
            cachePut(batch[i].text, t);
          }
        });
      } catch (e) { /* 交给下方 Google 兜底/失败标记 */ }
    }
    // 仍缺的行（歌词版权拒绝的高发区）：终极兜底——不求翻译求大意概括。
    // 模型版权策略拦"逐句翻译歌词"，但几乎不拦"概括她在唱什么"；🎵 前缀上屏，
    // 观众至少知道这句唱的内容。概括不进缓存：点击该行可再拿一次完整译文的尝试
    const stillIdx = [];
    batch.forEach((b, i) => { if (!got.has(i + 1)) stillIdx.push(i); });
    if (stillIdx.length) {
      try {
        const arr = await callLLMParaphrase(cfg, stillIdx.map((i) => batch[i].text), cfg.tgtLang);
        arr.forEach((t, k) => {
          const i = stillIdx[k];
          if (t && !looksLikeRefusal(t)) {
            got.add(i + 1);
            post({ type: 'asr-translated', id: batch[i].id, text: t });
          }
        });
      } catch (e) { /* 交给下方 Google 兜底/失败标记 */ }
    }
    // 未返回的行：Google 快速兜底（单次 6s，连续失败则熔断 120s——大陆网络常不可达，别每句挂 10 秒）；
    // 全部失败时给出可点击重试的标记，绝不让译文停在无声的"…"
    await Promise.all(batch.map(async (b, i) => {
      if (got.has(i + 1)) return;
      if (isGoogleDown()) {
        post({ type: 'asr-translated', id: b.id, text: '⚠ 译失败·点击重试' });
        return;
      }
      const t = await translateGoogle(b.text, cfg.srcLang, cfg.tgtLang, 1, 6000);
      if (t) {
        post({ type: 'asr-translated', id: b.id, text: t });
        pushContext(b.text, t);
      } else {
        tripGoogleBreaker(120000);
        post({ type: 'asr-translated', id: b.id, text: '⚠ 译失败·点击重试' });
      }
    }));
    return;
  }

  // Google / DeepL：并行逐句。Google 主备双通道都失败时熔断 2 分钟并明示——
  // 免费接口按 IP 限流（429"Sorry..."页）很常见，绝不让译文停在无声的"…"上
  const batch = pendingLines.splice(0, 12);
  const p2 = cfg.trProvider || 'google';
  const down = isGoogleDown();
  const results = await Promise.all(
    batch.map(async (b) => {
      if (down) return [b, null];
      if (p2 === 'deepl' && cfg.deeplKey) return [b, await translateDeepL(cfg, b.text, cfg.tgtLang)];
      return [b, await translateGoogle(b.text, cfg.srcLang, cfg.tgtLang, 1, 6000)];
    })
  );
  let gotN = 0;
  for (const [b, t] of results) {
    if (t) {
      gotN++;
      post({ type: 'asr-translated', id: b.id, text: t });
      pushContext(b.text, t);
    }
  }
  if (p2 === 'google' && gotN === 0 && batch.length) {
    if (!down) announceGoogleDown();
    batch.forEach((b) => post({ type: 'asr-translated', id: b.id, text: '⚠ 译失败·点击重试' }));
  }
}

// 单句重译（面板点击译文触发）：优先大模型（带上下文与术语表），非 LLM 配置走单句通道
async function retryTranslate(id, text) {
  if (!isRunning() || !text) return;
  try {
    if (cfg.trProvider === 'llm' && cfg.llmBaseUrl && cfg.llmKey) {
      let gotT = null;
      await callLLMStream(cfg, [text], cfg.tgtLang, contextLines, (n, t) => {
        if (n === 1 && t && !looksLikeRefusal(t)) gotT = t;
      });
      if (gotT) {
        post({ type: 'asr-translated', id, text: gotT });
        pushContext(text, gotT);
        return;
      }
      // 歌词拒绝的行点击重试也要能活：降级为大意概括（🎵 前缀），绝不空手而归
      try {
        const arr = await callLLMParaphrase(cfg, [text], cfg.tgtLang);
        if (arr[0] && !looksLikeRefusal(arr[0])) {
          post({ type: 'asr-translated', id, text: arr[0] });
          return;
        }
      } catch (e) { /* 落到下方告警 */ }
      throw new Error('译文被模型拒绝（歌词版权策略），稍后再试');
    }
    const t = await translateText(text, cfg.srcLang, cfg.tgtLang);
    if (t) post({ type: 'asr-translated', id, text: t });
  } catch (e) {
    console.warn('单句重译失败:', e && e.message);
    warnTranslate(e && e.message);
  }
}

// ===== index.js =====
// 引擎编排层（offscreen document 入口模块）：
// 接收标签页音频流 → 按静音/时长切分语音段 → 并发识别（本地/云端/混合）→ 顺序门 → 句子拼装 → 翻译调度 → 推送字幕 UI。
// 各业务域在独立模块中实现，本文件只负责把它们编排成一场会话。

console.log('[YT字幕] 引擎 ' + ENGINE_VERSION + ' 已加载', { pipeline: typeof pipeline });

// 引擎导出异常时尽早暴露明确错误，而不是等到调用时抛难以理解的 ReferenceError
if (typeof pipeline !== 'function' || !env) {
  try {
    chrome.runtime.sendMessage({
      type: 'offscreen-status',
      status: '',
      error: '识别引擎初始化异常：transformers.min.js 未导出 pipeline/env（文件可能损坏或未正确打补丁，请重新运行 npm run get-libs）',
    });
  } catch (e) { /* 忽略 */ }
}

let running = false;
let asr = null;          // 首条 Whisper 识别管线（兼容旧引用）
let asrOptions = {};     // generate 时的附加参数
let asrPool = [];        // 管线池：[{ asr, options, device, name }]；GPU 模式下双管线并行识别，吞吐接近翻倍
let workerCount = 0;     // 运行中的识别协程数（每条管线一个，常驻循环）
let chunkSeq = 0;        // 语音段流水号：双管线并行时完成顺序可能颠倒，用它保证字幕按说话顺序输出
let emitQ = new Map();   // 顺序输出门：seq -> {text, enqAt}，凑齐连续序号后按序进拼装器
let nextEmit = 1;        // 下一个待上屏的流水号
let chunkWaiters = [];   // 空闲识别协程的唤醒回调队列
let scaleMonitor = null;   // GPU 自适应扩容监视器句柄（持续积压时自动加第三条管线）
let addingPipeline = false; // 是否正在加载扩容管线（防止重入）
let paused = false;        // 暂停识别：丢弃新语音段（声音照常回放），不出新字幕
let audioCtx = null;
let replayCtx = null;    // 独立的默认采样率回放上下文
let replayAnalyser = null; // 回放链路分析器（诊断：验证回放确实在输出音频）
let srcNode = null;
let workletNode = null;
let settings = null;
let queue = [];          // 待识别的语音段 {samples, enqAt}
let lineSeq = 0;
let asrCleaner = null;   // 识别文本清洗器（含去重窗口与有声无字诊断），每次会话重建
let droppedWarned = false;
let activeDevice = null; // 当前实际运行的设备：webgpu / wasm / cloud / hybrid
let activeModelName = ''; // 实际加载的模型名（状态栏显示）
let consecutiveFailures = 0; // 连续识别失败计数（用于 GPU/云端通道摘除与自动降级）
let sentenceBuf = [];    // 句子拼装缓冲：把被停顿切断的片段拼成完整句再翻译
let sentenceLastAt = 0;  // 最近一个片段进入缓冲的时间
let sentenceSince = 0;   // 当前句子首片段时间
let sentenceTimer = null; // 拼装兜底定时器

// 注意：必须同步回执，background 端在 await sendMessage；耗时的启动流程放到异步执行
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'begin-capture') {
    start(msg.streamId, msg.settings);
    sendResponse({ ok: true });
  } else if (msg.type === 'end-capture') {
    stop();
    sendResponse({ ok: true });
  } else if (msg.type === 'retry-translate') {
    retryTranslate(msg.id, msg.text);
    sendResponse({ ok: true });
  } else if (msg.type === 'set-paused') {
    paused = !!msg.paused;
    if (paused) queue = [];
    postStatus(paused ? '⏸ 已暂停字幕（面板"继续"恢复，声音不受影响）' : getBannerStatus() || '实时翻译中…');
    sendResponse({ ok: true });
  }
  return false;
});

async function start(streamId, s) {
  if (running) return;
  running = true;
  paused = false;
  settings = s || {};
  queue = [];
  lineSeq = 0;
  emitQ = new Map();
  chunkSeq = 0;
  nextEmit = 1;
  droppedWarned = false;
  resetPipelineErrors();
  consecutiveFailures = 0;
  initTranslateQueue(settings, () => running);
  // 有声无字告警：明确告知"这是识别层限制、不是翻译问题"，用户才不用对着空字幕猜原因
  asrCleaner = createAsrCleaner(() => {
    postStatus('⚠ 连续多段有声音但识别为空（非翻译问题）。当前识别模型对这类音频不敏感——常见于游戏语音/BGM/唱歌混杂的段落；换更强的模型（turbo）或云端/混合引擎通常可明显改善');
    setTimeout(() => { if (running && getBannerStatus()) postStatus(getBannerStatus()); }, 8000);
  });

  try {
    // streamId 有时效，必须先接通音频，再加载（可能很耗时的）模型
    postStatus(`正在连接标签页音频…（引擎 ${ENGINE_VERSION}）`);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    // 标签页被关闭/停止共享时自动结束
    stream.getAudioTracks()[0].addEventListener('ended', () => stop('音频捕获已结束'));

    audioCtx = new AudioContext({ sampleRate: 16000 });
    // 无用户手势时 AudioContext 可能被浏览器挂起（表现为无声），主动恢复
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch (e) { /* 忽略，worklet 连接后仍有机会恢复 */ }
    }
    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('offscreen/worklet-processor.v1.js'));

    srcNode = audioCtx.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(audioCtx, 'chunk-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      // 完整优先用更长的分段（上下文越足、断句和同音字纠错越准，也减少连续说话时被硬切断）；实时优先用短分段降低延迟
      processorOptions: { maxSec: settings.mode === 'realtime' ? 4.5 : 13 },
    });
    workletNode.port.onmessage = (e) => {
      const d = e.data || {};
      // 兼容两种载荷：新版 {samples, pauseEnded} / 旧版裸 Float32Array
      enqueueChunk(d.samples || d, !!d.pauseEnded);
    };

    srcNode.connect(workletNode);
    // worklet 需要连到 destination 才会被调度；增益为 0（回放不走 16k 上下文，见下）
    const tap = audioCtx.createGain();
    tap.gain.value = 0;
    workletNode.connect(tap);
    tap.connect(audioCtx.destination);

    // 回放：独立的默认采样率 AudioContext——既保证驱动兼容性，又与识别处理解耦
    if (settings.playAudio !== false) {
      replayCtx = new AudioContext();
      if (replayCtx.state === 'suspended') {
        try { await replayCtx.resume(); } catch (e) { /* 稍后重试 */ }
      }
      const replaySrc = replayCtx.createMediaStreamSource(stream);
      const replayGain = replayCtx.createGain();
      replayGain.gain.value = 1;
      replayAnalyser = replayCtx.createAnalyser();
      replayAnalyser.fftSize = 512;
      replaySrc.connect(replayGain);
      replayGain.connect(replayAnalyser);
      replayAnalyser.connect(replayCtx.destination);
      // 诊断接口：供端到端测试读取回放链路的实际输出电平与上下文状态
      window.__ytlReplayDiag = {
        level: () => {
          if (!replayAnalyser) return -1;
          const buf = new Float32Array(replayAnalyser.fftSize);
          replayAnalyser.getFloatTimeDomainData(buf);
          let s = 0;
          for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
          return Math.sqrt(s / buf.length);
        },
        state: () => ({
          replay: replayCtx ? replayCtx.state : 'closed',
          capture: audioCtx ? audioCtx.state : 'closed',
        }),
      };
    }

    if (settings.asrEngine === 'cloud') {
      // 云端识别：三个"管线"实为同一无状态对象（每段独立上传），复用整套并发/顺序门逻辑；
      // 三路并行上传，积压清空更快（服务端转写快，瓶颈在串行等待）
      const inst = makeCloudAsr(settings);
      asrPool = [inst, inst, inst];
      asr = inst.asr;
      activeDevice = 'cloud';
      activeModelName = inst.name;
    } else if (settings.asrEngine === 'hybrid') {
      // 混合并行（多路模型）：云端两条即时可用（本地模型还在加载时字幕就开始出），
      // 本地管线后台就绪后加入池——多路同时吃队列，单段排队延迟趋近于零，吞吐翻倍。
      // GPU 忙时下一句直接走云端，云端慢时本地先回，谁先空谁接活
      const c = makeCloudAsr(settings);
      asrPool = [c, c];
      asr = c.asr;
      activeDevice = 'hybrid';
      activeModelName = '云端×2';
      createPipeline(settings, settings.model || 'base', false, true)
        .then((p) => {
          if (p && running && asrPool.filter((x) => x.kind !== 'cloud').length < 1) {
            asrPool.push(p);
            activeModelName = p.name + '+云端';
            postBanner(`混合并行已就绪（${p.name} + 云端，共 ${asrPool.length} 路同时识别）`);
            startWorkers();
          }
        })
        .catch(() => { /* 云端两路继续跑 */ });
    } else if (!asrPool.length || asrPool.some((x) => x.kind === 'cloud') || activeDevice === 'hybrid') {
      postStatus('正在加载语音识别模型（首次使用需下载，之后有缓存）…');
      const p = await createPipeline(settings, settings.model || 'base', false);
      if (!p) {
        await stop();
        return;
      }
      asrPool = [p];
      asr = p.asr;
      asrOptions = p.options;
      activeDevice = p.device;
      activeModelName = p.name;
    }

    const deviceLabel = activeDevice === 'webgpu' ? 'GPU' : activeDevice === 'cloud' ? '云端' : activeDevice === 'hybrid' ? '多路并行' : 'CPU';
    postBanner(`实时翻译中…（${activeModelName || settings.model || '?'} · ${deviceLabel}）`);
    startWorkers();
    // GPU 模式：后台再加载一条相同管线（权重已缓存，秒级完成），双管线并行识别。
    // 加载失败完全不影响单管线运行。
    if (activeDevice === 'webgpu' && asrPool.length < 2 && navigator.gpu) {
      createPipeline(settings, settings.model || 'base', false, true)
        .then((p2) => {
          if (p2 && running && asrPool.length < 2) {
            asrPool.push(p2);
            postBanner(`双管线并行识别已启用（${p2.name} · GPU ×2，吞吐翻倍）`);
            startWorkers();
          }
        })
        .catch(() => { /* 单管线继续跑 */ });
    }
    startScaleMonitor();
  } catch (e) {
    await stop('启动失败：' + (e && e.message || e));
  }
}

async function stop(reason) {
  running = false;
  try { if (srcNode) srcNode.disconnect(); } catch (e) { /* 忽略 */ }
  try { if (workletNode) workletNode.disconnect(); } catch (e) { /* 忽略 */ }
  try { if (replayCtx) await replayCtx.close(); } catch (e) { /* 忽略 */ }
  try { if (audioCtx) await audioCtx.close(); } catch (e) { /* 忽略 */ }
  srcNode = null;
  workletNode = null;
  replayCtx = null;
  audioCtx = null;
  queue = [];
  emitQ = new Map();
  chunkSeq = 0;
  nextEmit = 1;
  notifyWorkers();
  sentenceBuf = [];
  sentenceSince = 0;
  sentenceLastAt = 0;
  if (sentenceTimer) { clearTimeout(sentenceTimer); sentenceTimer = null; }
  shutdownTranslate();
  if (scaleMonitor) { clearInterval(scaleMonitor); scaleMonitor = null; }
  post({ type: 'capture-ended', reason: reason || '' });
}

// ---------- 语音段队列与并发调度 ----------

function enqueueChunk(samples, pauseEnded) {
  if (!running || paused) return;
  const item = { samples, enqAt: Date.now(), pauseEnded: !!pauseEnded };
  if (settings.mode === 'realtime' && queue.length >= Math.max(1, asrPool.length)) {
    // 实时优先：识别忙时只保留最新一段，保证字幕紧跟直播
    queue = [item];
    if (!droppedWarned) {
      droppedWarned = true;
      postStatus('识别速度跟不上语速，已自动跳过部分语音以保持字幕同步（可在设置中切换"完整优先"模式）');
      setTimeout(() => { droppedWarned = false; }, 10000);
    }
  } else {
    // 完整优先：逐句排队不遗漏，识别慢就慢慢追（设上限仅防内存无限增长）
    queue.push(item);
    const CAP = 120;
    if (queue.length > CAP) {
      queue.splice(0, queue.length - CAP);
      if (!droppedWarned) {
        droppedWarned = true;
        postStatus('积压语音过多（识别远慢于语速），已丢弃最旧的约 10 分钟内容。建议换"快速"模型');
        setTimeout(() => { droppedWarned = false; }, 30000);
      }
    }
  }
  startWorkers();
  notifyWorkers();
}

// 识别协程：每条管线一个常驻循环，从同一队列取段并行推理
function startWorkers() {
  while (running && workerCount < asrPool.length) {
    const p = asrPool[workerCount];
    workerCount++;
    runWorker(p).finally(() => {
      workerCount--;
      // 自愈：快速停止/重启或管线池重建后，旧协程退出时可能没人再启动新协程，这里兜底补齐
      if (running) startWorkers();
    });
  }
}

function notifyWorkers() {
  const ws = chunkWaiters;
  chunkWaiters = [];
  ws.forEach((r) => r());
}

// GPU 自适应扩容：持续满载积压（连续两个检查周期队列深度 ≥ 管线数）时自动加本地管线。
// 纯本地：上限 3 条；混合模式：本地上限 2 条（另有云端 2 路）。仅完整模式会积累队列触发。
function startScaleMonitor() {
  if (scaleMonitor) clearInterval(scaleMonitor);
  let fullTicks = 0;
  scaleMonitor = setInterval(async () => {
    if (!running || addingPipeline) return;
    if (activeDevice !== 'webgpu' && activeDevice !== 'hybrid') return;
    const cap = activeDevice === 'hybrid' ? 2 : 3;
    const localCount = asrPool.filter((x) => x.kind !== 'cloud').length;
    if (localCount >= cap) { clearInterval(scaleMonitor); scaleMonitor = null; return; }
    fullTicks = queue.length >= asrPool.length ? fullTicks + 1 : 0;
    if (fullTicks < 2) return;
    fullTicks = 0;
    addingPipeline = true;
    try {
      const pN = await createPipeline(settings, settings.model || 'base', false, true);
      if (pN && running && asrPool.filter((x) => x.kind !== 'cloud').length < cap) {
        asrPool.push(pN);
        postBanner(`已扩容至 ${asrPool.length} 路并行识别（含 ${pN.name}，吞吐再提升）`);
        startWorkers();
      }
    } catch (e) { /* 扩容失败维持现状 */ } finally {
      addingPipeline = false;
    }
  }, 5000);
}

// 等新语音段到来，或最多 ms 毫秒后自行醒来重查（兜底，防唤醒丢失）
const waitForChunk = (ms) => new Promise((r) => {
  const t = setTimeout(r, ms);
  chunkWaiters.push(() => { clearTimeout(t); r(); });
});

async function runWorker(p) {
  while (running && asrPool.includes(p)) {
    if (!queue.length) {
      await waitForChunk(500);
      continue;
    }
    const item = queue.shift();
    const seq = ++chunkSeq;
    let text = null;
    try {
      try {
        text = await transcribeChunk(p, item.samples);
      } catch (e1) {
        // 束搜索在个别引擎/驱动上不被支持，首个片段就会抛错：自动关闭并重试本段，不计入连续失败
        if (settings.beamSearch && p.kind !== 'cloud') {
          settings.beamSearch = false;
          postStatus('精细解码在当前环境不可用，已自动关闭并继续');
          text = await transcribeChunk(p, item.samples);
        } else {
          throw e1;
        }
      }
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures++;
      console.warn('识别单段失败(' + consecutiveFailures + '):', e && e.message);
      if (consecutiveFailures >= 3 && p.kind === 'cloud') {
        // 云端连续失败（Key 错误/额度耗尽/网络不通）：摘除云端通道；没有本地管线则加载本地，字幕不中断
        consecutiveFailures = 0;
        emitQ.set(seq, { text: null, enqAt: item.enqAt }); // 本段放弃，别让顺序门卡住
        asrPool = asrPool.filter((x) => x.kind !== 'cloud');
        asr = null;
        if (!asrPool.length) {
          postStatus('云端识别连续失败，自动切换本地模型（请检查 Key/额度/网络，稳定后可在设置切回）…');
          const p1 = await createPipeline(settings, settings.model || 'base', false);
          if (!p1) {
            await stop('云端识别失败且本地模型加载失败');
            return;
          }
          asrPool = [p1];
          asr = p1.asr;
          asrOptions = p1.options;
          activeDevice = p1.device;
          activeModelName = p1.name;
          postBanner(`已切换本地识别（${activeModelName} · ${activeDevice === 'webgpu' ? 'GPU' : 'CPU'}）`);
        } else {
          postBanner('云端通道连续失败已停用，本地识别继续（Key/额度恢复后可在设置重新开启）');
        }
        startWorkers();
        return;
      }
      if (consecutiveFailures >= 3 && p.device === 'webgpu') {
        // GPU 推理挂起/异常：本地通道降级 CPU；混合模式下云端通道保留不受影响
        consecutiveFailures = 0;
        emitQ.set(seq, { text: null, enqAt: item.enqAt }); // 本段放弃，别让顺序门卡住
        asrPool = asrPool.filter((x) => x.kind === 'cloud');
        asr = null;
        postStatus('GPU 识别连续异常，自动切换 CPU 模式（速度变慢但不中断）…');
        const p1 = await createPipeline(settings, settings.model || 'base', true);
        if (p1) {
          asrPool.push(p1);
          asr = p1.asr;
          asrOptions = p1.options;
          activeDevice = asrPool.some((x) => x.kind === 'cloud') ? 'hybrid' : p1.device;
          activeModelName = asrPool.some((x) => x.kind === 'cloud') ? activeModelName : p1.name;
        } else if (!asrPool.length) {
          await stop('识别异常且 CPU 重建失败');
          return;
        }
        postBanner(asrPool.some((x) => x.kind === 'cloud')
          ? '已切换：本地走 CPU，云端通道继续（混合模式）'
          : '实时翻译中…（CPU 模式，较慢——建议在设置中换"快速"模型）');
        startWorkers();
        return;
      }
      if (consecutiveFailures >= 6) {
        await stop('识别连续失败');
        return;
      }
    }
    emitOrdered(seq, text, item.enqAt, item.pauseEnded);
  }
}

// 顺序输出门：双管线并行时各段完成顺序可能颠倒，凑齐连续流水号后按说话顺序送入拼装器，
// 保证句子拼装与上屏顺序和主播说话顺序一致
function emitOrdered(seq, text, enqAt, pauseEnded) {
  emitQ.set(seq, { text: text || null, enqAt, pauseEnded });
  while (emitQ.has(nextEmit)) {
    const cur = emitQ.get(nextEmit);
    emitQ.delete(nextEmit);
    nextEmit++;
    if (cur && cur.text) emitText(cur.text, cur.enqAt, cur.pauseEnded);
  }
}

// ---------- 句子拼装：把被停顿切断的片段合并成完整句再上屏/翻译（完整优先模式） ----------

function postLine(text, enqAt) {
  if (!running) return; // 停止后不再补发（含拼装器兜底定时器触发的输出）
  const id = ++lineSeq;
  const lat = enqAt ? Math.max(0, Date.now() - enqAt) : null; // "主播说完→字幕上屏"延迟，面板展示用
  post({ type: 'asr-line', id, text, ts: Date.now(), lat });
  scheduleTranslate(id, text);
}

function flushSentence() {
  if (sentenceTimer) { clearTimeout(sentenceTimer); sentenceTimer = null; }
  if (!sentenceBuf.length) return;
  const text = sentenceBuf.map((s) => s.text).join('').trim();
  const enqAt = sentenceBuf.reduce((min, s) => Math.min(min, s.enqAt), Infinity);
  sentenceBuf = [];
  sentenceSince = 0;
  sentenceLastAt = 0;
  if (text) postLine(text, enqAt === Infinity ? 0 : enqAt);
}

function emitText(text, enqAt, pauseEnded) {
  if (!text) return;
  // 实时优先：片段直接上屏（保延迟）；完整优先：拼装成句（保连贯）
  if (settings.mode === 'realtime') {
    postLine(text, enqAt);
    return;
  }
  const now = Date.now();
  // 上一片段停留超过 1.2 秒还没等来后续：说明那已是完整句，先输出
  if (sentenceBuf.length && now - sentenceLastAt > 1200) flushSentence();
  sentenceBuf.push({ text, enqAt: enqAt || now });
  sentenceLastAt = now;
  if (!sentenceSince) sentenceSince = now;

  const joined = sentenceBuf.map((s) => s.text).join('');
  const sentenceEnd = /[。！？!?…、]$/.test(joined.slice(-1)) && joined.length > 12; // 句号问号叹号结尾视为完整句（顿号不算）
  const hardEnd = /[。！？!?…]$/.test(joined);
  // 停顿结束（VAD 因静音切段）且内容够长：几乎可以肯定是完整句，立即上屏，不等兜底定时——
  // 这是延迟从 3~4s 压到 1~2s 的关键路径；就算偶尔切早了，相邻行同批送翻时大模型会合并理解
  const pauseComplete = pauseEnded && joined.length >= 25;
  if (hardEnd || sentenceEnd || pauseComplete || joined.length >= 120 || sentenceBuf.length >= 4 || now - sentenceSince > 12000) {
    flushSentence();
    return;
  }
  // 原文先行：句子还在拼装时，把已积累片段推给面板实时显示（成句后由 asr-line 替换），
  // 用户在译文出来前就能看到主播说了什么——感知延迟直降
  if (joined.length >= 8) post({ type: 'asr-partial', text: joined });
  // 兜底定时：后续片段迟迟不来就输出已积累部分，避免字幕无限延迟。
  // 日语文本常无句尾标点，短片段等不到标点/停顿标记时由本定时器兜底，必须短
  if (sentenceTimer) clearTimeout(sentenceTimer);
  sentenceTimer = setTimeout(flushSentence, 900);
}

// ---------- 单段识别 ----------

// 识别单个语音段（inst = 管线池成员，本地或云端）。返回识别文本；被过滤的段返回空串。
async function transcribeChunk(inst, samples) {
  // 云端管线：直接上传转写，本地解码参数不适用
  if (inst.kind === 'cloud') {
    const outCloud = { text: await cloudTranscribe(settings, samples) };
    const t = asrCleaner.clean(outCloud);
    asrCleaner.note(t, samples);
    return t;
  }

  // 完整优先放宽生成长度上限（保准确）；实时优先收紧（保速度）
  const modeCap = settings.mode === 'realtime' ? 96 : 192;
  const sec = samples.length / 16000;
  const tokenCap = Math.min(modeCap, Math.ceil(sec * 10) + 30);
  const opts = { ...inst.options, max_new_tokens: tokenCap };
  if (settings.beamSearch) opts.num_beams = 2; // 束搜索：解码候选更精细、更准，代价是识别变慢
  const lang = settings.srcLang && settings.srcLang !== 'auto' ? settings.srcLang : null;
  if (lang) opts.language = lang;

  // WebGPU 推理在个别显卡驱动上会挂起：120 秒超时保护，超时丢弃该段并计入连续失败
  const out = await Promise.race([
    inst.asr(samples, opts),
    new Promise((_, reject) => setTimeout(() => reject(new Error('识别超时（GPU 可能挂起）')), 120000)),
  ]);
  const t = asrCleaner.clean(out);
  asrCleaner.note(t, samples);
  return t;
}
