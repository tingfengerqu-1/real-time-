// 引擎编排层（offscreen document 入口模块）：
// 接收标签页音频流 → 按静音/时长切分语音段 → 并发识别（本地/云端/混合）→ 顺序门 → 句子拼装 → 翻译调度 → 推送字幕 UI。
// 各业务域在独立模块中实现，本文件只负责把它们编排成一场会话。

import { pipeline, env, ENGINE_VERSION } from './engine-env.js';
import { post, postStatus, postBanner, getBannerStatus } from './bus.js';
import { createPipeline, resetPipelineErrors } from './asr-local.js';
import { makeCloudAsr, cloudTranscribe } from './asr-cloud.js';
import { createAsrCleaner } from './asr-clean.js';
import { initTranslateQueue, shutdownTranslate, scheduleTranslate, retryTranslate } from './tr-queue.js';

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
    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('offscreen/worklet-processor.js?v=5'));

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
