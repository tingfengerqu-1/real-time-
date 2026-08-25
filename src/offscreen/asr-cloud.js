// 云端识别：OpenAI 风格 /audio/transcriptions（智谱 glm-asr 等）。
// LLM 级抗噪与上下文理解，对 BGM/游戏音效混杂的直播音频明显更准；接口限制 30s/段，与分段长度天然匹配。

// 智谱端点的模型名大小写敏感且全小写：统一归一，避免"模型不存在"
export function normalizeZhipuModel(name, root) {
  const n = String(name || '').trim();
  return /bigmodel|zhipu/i.test(String(root || '')) ? n.toLowerCase() : n;
}

// Float32 16kHz 单声道 → 16bit PCM WAV Blob（转写接口的标准输入格式）
export function encodeWav(samples) {
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

export async function cloudTranscribe(cfg, samples) {
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
export function makeCloudAsr(cfg) {
  return {
    kind: 'cloud',
    device: 'cloud',
    name: normalizeZhipuModel((cfg && cfg.asrCloudModel) || 'glm-asr-2512', cfg && cfg.llmBaseUrl),
    options: {},
    asr: async (samples) => ({ text: await cloudTranscribe(cfg, samples) }),
  };
}
