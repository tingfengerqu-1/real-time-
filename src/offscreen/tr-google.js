// Google 免费翻译：主备双通道 + 熔断。
//
// 主接口 client=gtx（逐句对齐）按 IP 激进限流（429 + "Sorry..." 页），
// 被限流时自动切 clients5 的 dict-chrome-ex 备用接口——两者限流池相互独立。
// 记住上次成功的通道优先使用，失败换另一条（天然定期重探）。
// 两通道都失败才返回 null（外层据此熔断/打失败标记）；熔断期内直接短路不再发请求。

import { postStatus } from './bus.js';

let googleDownUntil = 0; // 熔断截止时间（双通道全挂时停 2 分钟，避免每句挂 10s）
let googlePrefer = 0;    // 上次成功的通道下标（0=gtx 主，1=clients5 备）

export function isGoogleDown() {
  return Date.now() < googleDownUntil;
}

export function tripGoogleBreaker(ms) {
  googleDownUntil = Date.now() + ms;
}

export function getGooglePrefer() {
  return googlePrefer;
}

export async function translateGoogle(text, sl, tl, attempts = 2, timeoutMs = 10000) {
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
export function announceGoogleDown() {
  tripGoogleBreaker(120000);
  postStatus('⚠ Google 免费翻译主/备通道均不可用（接口限流或网络不通）：已暂停 2 分钟，建议切换"大模型翻译"');
}
