// 翻译调度：小窗口攒批 → 流式请求 → 逐句上屏，带精确缓存、上下文与多层自愈。
// 自愈链路：LLM 流式 → callLLMSimple 极简重试 → callLLMParaphrase 大意概括 → Google 兜底 → 可点击重试的失败标记。
// 会话状态（cfg/isRunning）由 index.js 在每次 start 时注入。

import { post, postStatus, postBanner, getBannerStatus } from './bus.js';
import { translateGoogle, isGoogleDown, tripGoogleBreaker, announceGoogleDown } from './tr-google.js';
import { translateDeepL } from './tr-deepl.js';
import { callLLMStream, callLLMSimple, callLLMParaphrase, looksLikeRefusal } from './tr-llm.js';

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

export function initTranslateQueue(settings, runningFn) {
  cfg = settings;
  isRunning = runningFn;
}

// 停止时清理：清掉待译队列与兜底定时器（在途请求自然结束，不影响）
export function shutdownTranslate() {
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
export function scheduleTranslate(id, text) {
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
export async function retryTranslate(id, text) {
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
