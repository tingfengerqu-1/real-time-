// Google 双通道翻译单测：直接 import 真实模块 tr-google.js，验证双通道切换/优先/熔断。
// fetch 用桩替换模拟：gtx 429、clients5 可用、多种返回形态、全失败熔断。
// 每个用例通过带查询串的动态 import 获得全新模块实例，隔离模块内状态（通道偏好/熔断时间）。

let seq = 0;
const fresh = () => import(`../src/offscreen/tr-google.js?case=${++seq}`);

// 按 URL 前缀路由到预设响应；res 形态对齐 fetch Response（ok/status/json）
let gtxResp = null; // () => {ok, status, json}
let c5Resp = null;
let calls = [];
const mkRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { if (typeof body === 'string') throw new Error('非 JSON'); return body; },
});
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  calls.push(String(url));
  return String(url).includes('translate.googleapis.com')
    ? (gtxResp ? gtxResp() : mkRes(429, ''))
    : (c5Resp ? c5Resp() : mkRes(429, ''));
};

const results = [];
const t = (name, ok, detail) => { results.push([name, ok, detail]); if (!ok) process.exitCode = 1; };

// 用例 1：gtx 429 → 自动切 clients5（显式 sl 形态 ["译文"]），并记住该通道
{
  const m = await fresh();
  gtxResp = () => mkRes(429, ''); c5Resp = () => mkRes(200, ['你好']); calls = [];
  const r = await m.translateGoogle('こんにちは', 'ja', 'zh-CN', 1, 3000);
  t('gtx限流自动切clients5', r === '你好' && m.getGooglePrefer() === 1 && calls.length === 2, JSON.stringify({ r, calls: calls.length, prefer: m.getGooglePrefer() }));
}

// 用例 2：下次优先走 clients5（只发 1 个请求），auto 形态 [["译文","语言"]]
{
  const m = await fresh();
  gtxResp = () => mkRes(429, ''); c5Resp = () => mkRes(200, [['你好世界', 'en']]);
  await m.translateGoogle('a', 'ja', 'zh-CN', 1, 3000); // 先把 prefer 切到 clients5
  calls = [];
  const r = await m.translateGoogle('hello world', 'auto', 'zh-CN', 1, 3000);
  t('优先上次成功通道+auto形态', r === '你好世界' && calls.length === 1 && calls[0].includes('clients5'), JSON.stringify({ r, calls }));
}

// 用例 3：gtx 正常时的经典形态 [[["译","原"]],..] 逐段拼接
{
  const m = await fresh();
  gtxResp = () => mkRes(200, [[['还能有', 'こんな'], ['这种事？', 'ことって']]]); c5Resp = null; calls = [];
  const r = await m.translateGoogle('こんなことって', 'ja', 'zh-CN', 1, 3000);
  t('gtx经典形态拼接', r === '还能有这种事？', JSON.stringify(r));
}

// 用例 4：主备都 429（单次尝试）→ null
{
  const m = await fresh();
  gtxResp = () => mkRes(429, ''); c5Resp = () => mkRes(429, ''); calls = [];
  const r = await m.translateGoogle('テスト', 'ja', 'zh-CN', 1, 3000);
  t('双通道全失败返回null', r === null, JSON.stringify(r));
}

// 用例 5：熔断期内直接短路，一个请求都不发
{
  const m = await fresh();
  m.tripGoogleBreaker(60000);
  gtxResp = () => mkRes(200, ['不该出现']); c5Resp = () => mkRes(200, ['不该出现']); calls = [];
  const r = await m.translateGoogle('テスト', 'ja', 'zh-CN', 2, 3000);
  t('熔断短路零请求', r === null && calls.length === 0, JSON.stringify({ r, calls: calls.length }));
}

// 用例 6：gtx 返回 200 但 body 是 HTML 拦截页（json 解析失败）→ 落到 clients5 成功
{
  const m = await fresh();
  gtxResp = () => mkRes(200, '<html>Sorry...</html>'); c5Resp = () => mkRes(200, ['备用通道译文']); calls = [];
  const r = await m.translateGoogle('テスト', 'ja', 'zh-CN', 1, 3000);
  t('HTML拦截页落备用通道', r === '备用通道译文', JSON.stringify(r));
}

globalThis.fetch = realFetch;
for (const [n, ok, d] of results) console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : '→ ' + d);
console.log('=== Google 双通道翻译测试完成 ===');
