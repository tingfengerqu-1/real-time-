// e2e 本地服务器：静态文件 + mock 大模型接口 + HF 镜像代理。
// 用法：node tests/e2e/server.cjs（端口 8765）
//   /mock-llm/*  模拟 OpenAI 兼容的流式大模型（SSE 逐句吐 <<n>>译文），用于真实验证流式翻译管线
//   /hf/*        代理到 hf-mirror.com，规避本地页面的跨域限制
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
};

const UPSTREAM = 'https://hf-mirror.com';

http.createServer(async (req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);

  if (p.startsWith('/mock-llm/') && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let lineCount = 1;
    try {
      const j = JSON.parse(body);
      const user = (j.messages || []).map((m) => m.content || '').join('\n');
      lineCount = (user.match(/^\d+\.\s/gm) || []).length || 1;
    } catch (e) { /* 默认 1 行 */ }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      send({ choices: [{ delta: { role: 'assistant' } }] });
      await sleep(1000); // 模拟首 token 延迟
      for (let i = 1; i <= lineCount; i++) {
        send({ choices: [{ delta: { content: `<<${i}>>【模拟】第${i}句译文` } }] });
        await sleep(1500); // 模拟逐句生成间隔
      }
      send({ choices: [{ delta: {} }, { finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    })();
    return;
  }

  if (p.startsWith('/hf/')) {
    const target = UPSTREAM + p.slice(3); // /hf/xxx -> https://hf-mirror.com/xxx
    try {
      const range = req.headers['range'];
      const up = await fetch(target, {
        headers: range ? { range } : {},
        redirect: 'follow',
      });
      const headers = {
        'content-type': up.headers.get('content-type') || 'application/octet-stream',
        'access-control-allow-origin': '*',
      };
      for (const h of ['content-length', 'content-range', 'etag']) {
        const v = up.headers.get(h);
        if (v) headers[h] = v;
      }
      res.writeHead(up.status, headers);
      const buf = Buffer.from(await up.arrayBuffer());
      res.end(buf);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('proxy error: ' + e.message);
    }
    return;
  }

  if (p === '/') p = '/test-audio.html';
  const file = path.join(__dirname, p);
  if (!file.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8765, () => console.log('e2e server on http://localhost:8765 (mock LLM: /mock-llm/*, hf proxy: /hf/*)'));
