// 大模型翻译（OpenAI 兼容 /chat/completions）：
//   callLLMStream     流式主力——SSE 逐 token 接收，译完一句立刻回调上屏
//   callLLMSimple     极简自愈——主链路失败后的兜底（无流式/无附加参数，绕开兼容性问题）
//   callLLMParaphrase 大意概括——歌词版权拒绝的终极通道（不求逐句翻译，只概括唱了什么）
// cfg 即本次会话的设置对象（Base URL/Key/模型名/术语表/直播背景等）。

import { normalizeZhipuModel } from './asr-cloud.js';

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
export function looksLikeRefusal(t) {
  const s = String(t || '').trim();
  if (!s || s.length > 60) return false;
  return /(歌词|版权|著作权)|(无法|不能|拒绝|抱歉|对不起)[^。！？!\n]{0,18}(提供|翻译|复述|输出|回答|协助)|i can('t|not) (reproduce|provide|translate)/i.test(s);
}

let glmNoThinking = false; // 当前 LLM 型号不接受 thinking 参数：置位后请求不再携带（会话内记忆）

export async function callLLMStream(cfg, texts, tl, ctxLines, onLine) {
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
export async function callLLMSimple(cfg, texts, tl) {
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
export async function callLLMParaphrase(cfg, texts, tl) {
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
