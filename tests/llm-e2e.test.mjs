// 大模型链路真实 HTTP 测试：直接 import 真实模块 tr-llm.js（callLLMStream/Simple/Paraphrase），
// 对本地 mock 服务器发起真实请求，覆盖 SSE 流式、宽容解析、thinking 自愈、429、极简与概括兜底。
// 每个用例通过带查询串的动态 import 获得全新模块实例（隔离 glmNoThinking 会话状态）。
import http from 'node:http';

let seq = 0;
const fresh = () => import(`../src/offscreen/tr-llm.js?case=${++seq}`);

const cfg = (over = {}) => ({ llmBaseUrl: '', llmKey: 'test-key', llmModel: 'GLM-4.7-Flash', tgtLang: 'zh-CN', srcLang: 'ja', translateDetail: 'quality', streamContext: '', glossary: '', ...over });

let lastBody = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const mode = req.url.replace('/chat/completions', '').replace('/', '') || 'marked';
    const j = JSON.parse(body);
    lastBody = j;
    if (mode === '400thinking') {
      if (j.thinking) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: '模型不支持 thinking 参数' } })); return; }
      sse(res, ['这个', '游戏太难了']);
      return;
    }
    if (mode === '429') { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"rate limited"}'); return; }
    if (mode === 'bare') { sse(res, ['这个游戏真的太难了']); return; }
    if (mode === 'json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '好的没问题。' } }] })); return; }
    if (mode === 'simple') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '1. 第一句译文\n2. 第二句译文' } }] })); return; }
    if (mode === 'gist') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '她在唱思念远方恋人的抒情歌\n2. 她在表达游戏失败的懊恼' } }] })); return; }
    if (mode.startsWith('gist2')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '她在唱歌' } }] })); return; }
    if (mode === 'marked') { sse(res, ['<<1>>没', '事没事\n<<2>>太吓', '人了']); return; }
    res.writeHead(404); res.end('{}');
  });
});
function sse(res, pieces) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  const t = setInterval(() => {
    if (i < pieces.length) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i] } }] })}\n\n`);
      i++;
    } else { clearInterval(t); res.write('data: [DONE]\n\n'); res.end(); }
  }, 10);
}
await new Promise((r) => server.listen(8899, r));

const results = [];
const t = (name, ok, detail) => { results.push([name, ok, detail]); if (!ok) process.exitCode = 1; };

// 用例 1：标准 <<n>> 标记 SSE 流（含跨块拆分）
{
  const out = [];
  await (await fresh()).callLLMStream(cfg({ llmBaseUrl: 'http://127.0.0.1:8899/marked' }), ['a', 'b'], 'zh-CN', [], (n, x) => out.push([n, x]));
  t('标准标记流', JSON.stringify(out) === JSON.stringify([[1, '没事没事'], [2, '太吓人了']]), JSON.stringify(out));
}

// 用例 2：单句裸译文（不按 <<行号>> 格式输出 → 宽容解析）
{
  const out = [];
  await (await fresh()).callLLMStream(cfg({ llmBaseUrl: 'http://127.0.0.1:8899/bare' }), ['このゲームむずすぎ'], 'zh-CN', [], (n, x) => out.push([n, x]));
  t('单句裸译文(宽容解析)', JSON.stringify(out) === JSON.stringify([[1, '这个游戏真的太难了']]), JSON.stringify(out));
}

// 用例 3：非流式 JSON 裸译文
{
  const out = [];
  await (await fresh()).callLLMStream(cfg({ llmBaseUrl: 'http://127.0.0.1:8899/json' }), ['おっけー'], 'zh-CN', [], (n, x) => out.push([n, x]));
  t('非流式JSON裸译文', JSON.stringify(out) === JSON.stringify([[1, '好的没问题。']]), JSON.stringify(out));
}

// 用例 4：400 拒绝 thinking → 自动去掉重试成功（会话内记忆）
{
  const out = [];
  await (await fresh()).callLLMStream(cfg({ llmBaseUrl: 'http://127.0.0.1:8899/400thinking' }), ['無理'], 'zh-CN', [], (n, x) => out.push([n, x]));
  t('400拒绝thinking自愈', out.length === 1 && out[0][1] === '这个游戏太难了', JSON.stringify(out));
}

// 用例 5：429 持续失败 → 应抛错（走外层自愈/告警路径）
{
  let threw = false;
  try { await (await fresh()).callLLMStream(cfg({ llmBaseUrl: 'http://127.0.0.1:8899/429' }), ['x'], 'zh-CN', [], () => {}); } catch (e) { threw = /429/.test(e.message); }
  t('429 抛错给外层', threw);
}

// 用例 6：极简自愈请求（编号列表输出对位）
{
  const arr = await (await fresh()).callLLMSimple(cfg({ llmBaseUrl: 'http://127.0.0.1:8899/simple' }), ['あ', 'い'], 'zh-CN');
  t('极简请求对位', JSON.stringify(arr) === JSON.stringify(['第一句译文', '第二句译文']), JSON.stringify(arr));
}

// 用例 7：大意概括兜底（歌词拒绝后的终极通道）：🎵 前缀 + 行前缀剥离 + 对位
{
  const arr = await (await fresh()).callLLMParaphrase(cfg({ llmBaseUrl: 'http://127.0.0.1:8899/gist' }), ['君を想う夜', 'あーあ負けた'], 'zh-CN');
  t('大意概括兜底', JSON.stringify(arr) === JSON.stringify(['🎵她在唱思念远方恋人的抒情歌', '🎵她在表达游戏失败的懊恼']), JSON.stringify(arr));
}

// 用例 8：概括兜底请求形态：非流式、单 user 消息；智谱域名时模型名自动小写
{
  const arr = await (await fresh()).callLLMParaphrase(cfg({ llmBaseUrl: 'http://127.0.0.1:8899/gist2' }), ['テスト'], 'zh-CN');
  const okBasic = arr[0] === '🎵她在唱歌' && lastBody && lastBody.stream === false
    && lastBody.messages.length === 1 && lastBody.messages[0].role === 'user';
  await (await fresh()).callLLMParaphrase(cfg({ llmBaseUrl: 'http://127.0.0.1:8899/gist2/bigmodel.cn' }), ['テスト'], 'zh-CN'); // 命中智谱域名正则 → 触发小写
  t('概括请求形态', okBasic && lastBody.model === 'glm-4.7-flash', JSON.stringify({ arr, body: lastBody }));
}

server.close();
if (server.closeAllConnections) server.closeAllConnections(); // 强断 keep-alive 连接，别让进程挂着不退出
for (const [n, ok, d] of results) console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : '→ ' + d);
console.log('=== LLM 链路真实 HTTP 测试完成 ===');
