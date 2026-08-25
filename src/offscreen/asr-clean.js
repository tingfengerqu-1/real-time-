// 识别文本清洗：Whisper/云端原始输出 → 可上屏的字幕文本。
// 职责：断句杂符清理、纯音乐/掌声噪声拦截、静音段幻觉黑名单、重复幻觉去重（副歌放行）、
// 以及"有声无字"诊断（段内响度达标但识别为空——识别层限制，需与翻译问题区分开）。

// 采样 RMS（抽样计算，诊断用）
export function rmsOf(samples) {
  let s = 0;
  const step = 8;
  let n = 0;
  for (let i = 0; i < samples.length; i += step) { s += samples[i] * samples[i]; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

// onLoudEmpty：连续多段"有声音但识别为空"时的告警回调（编排层注入，负责文案与恢复横幅）
export function createAsrCleaner(onLoudEmpty) {
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
