// 端到端真实验证：启动带扩展的真实 Chrome -> 播放日语语音 -> 手动触发字幕捕获 ->
// 断言：面板出现、多行原文上屏、译文填充完成。全流程走真实代码路径（含引擎、模型下载、翻译）。
//
// 用法：先启动 node tests/e2e/server.cjs，再 node tests/e2e/run-e2e.cjs
// 注意：
//   - tabCapture 必须由真实用户手势触发，脚本会在第 4 步等待你在浏览器里点击
//     扩展图标 -> "开始字幕"
//   - Chrome 稳定版 137+ 忽略 --load-extension 参数；请用 Chrome Dev/Beta/Canary，
//     或用环境变量 CHROME_PATH 指定可用渠道的可执行文件
//   - 音频样本（ja2.ogg 等）需先放入 tests/e2e/assets/（见 assets/README.md）

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEBUG_PORT = 9223;
const PAGE_URL = 'http://localhost:8765/test-audio.html';
const TIMEOUT_MS = 420000; // 模型下载 + 多轮识别的宽裕上限

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome Dev\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome SxS\\Application\\chrome.exe') : null,
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome 可执行文件（可用环境变量 CHROME_PATH 指定）');
}

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function waitDebugPort() {
  for (let i = 0; i < 60; i++) {
    try { return await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`); } catch (e) { await sleep(500); }
  }
  throw new Error('Chrome 调试端口未就绪');
}

class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('页面执行异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    return r.result && r.result.value;
  }
}

async function pageProbe(page) {
  return page.eval(`(() => {
    const lines = [...document.querySelectorAll('.ytl-sub-line')];
    const trans = [...document.querySelectorAll('.ytl-sub-trans')].map((e) => e.textContent);
    return JSON.stringify({
      panel: !!document.getElementById('ytl-sub-panel'),
      status: (document.querySelector('.ytl-sub-status') || { textContent: '' }).textContent,
      n: lines.length,
      origs: [...document.querySelectorAll('.ytl-sub-orig')].map((e) => e.textContent).slice(-5),
      translatedCount: trans.filter((t) => t && t !== '…').length,
      audioState: (document.getElementById('state') || { textContent: '' }).textContent,
      audioPaused: (document.querySelector('audio') || { paused: null }).paused,
    });
  })()`);
}

async function main() {
  const chromePath = findChrome();
  const profileDir = path.join(os.tmpdir(), 'rt-e2e-profile-' + Date.now());
  const extDir = path.join(__dirname, '..', '..', 'src');

  const proc = spawn(chromePath, [
    '--user-data-dir=' + profileDir,
    '--load-extension=' + extDir,
    '--remote-debugging-port=' + DEBUG_PORT,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--window-size=1200,860',
    'about:blank',
  ], { stdio: 'ignore' });
  console.log('[1/6] 已启动真实浏览器:', chromePath);

  let browser = null;
  let sw = null;
  let page = null;

  try {
    await waitDebugPort();
    browser = new Cdp((await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).webSocketDebuggerUrl);
    await browser.send('Target.createTarget', { url: PAGE_URL });
    console.log('[2/6] 已打开测试页:', PAGE_URL);

    // 等待本扩展的 service worker 出现（按扩展名精确匹配，避免抓到系统内置扩展的 SW）
    for (let i = 0; i < 60 && !sw; i++) {
      const list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const cands = list.filter((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
      for (const t of cands) {
        try {
          const c = new Cdp(t.webSocketDebuggerUrl);
          const name = await c.eval('(chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().name : ""');
          if (name === 'YT 实时翻译字幕') { sw = c; break; }
          c.close();
        } catch (e) { /* 尝试下一个 */ }
      }
      if (!sw) await sleep(1000);
    }
    if (!sw) throw new Error('本扩展的 Service Worker 未出现（扩展加载失败？）');

    // 环境自检：确认关键 API 可用
    const probe = await sw.eval(`(() => {
      const m = chrome.runtime.getManifest();
      return JSON.stringify({
        version: m.version,
        permissions: m.permissions,
        storage: typeof chrome.storage,
        scripting: typeof chrome.scripting,
        tabs: typeof chrome.tabs,
        offscreen: typeof chrome.offscreen,
        tabCapture: typeof chrome.tabCapture,
      });
    })()`);
    console.log('[3/6] 扩展 SW 就绪:', probe);
    const probeInfo = JSON.parse(probe);
    if (probeInfo.storage !== 'object' || probeInfo.scripting !== 'object') {
      throw new Error('扩展 API 不完整: ' + probe);
    }

    // 设置：tiny 模型 + 实时优先 + mock 大模型翻译（server.cjs 提供 /mock-llm）
    await sw.eval(`chrome.storage.local.set({ model: 'tiny', mode: 'realtime', srcLang: 'ja', tgtLang: 'zh-CN', trProvider: 'llm', llmBaseUrl: 'http://localhost:8765/mock-llm/v4', llmKey: 'test-key', llmModel: 'mock-model', dlSource: 'auto', playAudio: true }).then(() => 'ok')`);

    // 先连接测试页
    let pageTarget = null;
    for (let i = 0; i < 30 && !pageTarget; i++) {
      const list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      pageTarget = list.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:8765/test-audio'));
      if (!pageTarget) await sleep(1000);
    }
    if (!pageTarget) throw new Error('找不到测试页调试目标');
    page = new Cdp(pageTarget.webSocketDebuggerUrl);

    // 等待真实用户手势触发（Chrome 安全策略要求 tabCapture 必须由真实用户调用扩展，程序化路径无法绕过）
    console.log('[4/6] 等待真实触发（请在浏览器中点击扩展图标 -> 开始字幕）…');
    let started = false;
    for (let i = 0; i < 120 && !started; i++) {
      await sleep(2000);
      try {
        const st = JSON.parse(await sw.eval(`chrome.storage.session.get('state').then((r) => JSON.stringify(r.state || {}))`));
        if (st.running) started = true;
      } catch (e) { /* SW 可能休眠，继续等 */ }
    }
    if (!started) throw new Error('等待真实触发超时（240 秒内未开始捕获）');
    console.log('     捕获已启动');

    console.log('[5/6] 轮询识别结果（模型首次下载可能需要 1-3 分钟）…');
    const start = Date.now();
    let lastInfo = '';
    let passed = false;
    while (Date.now() - start < TIMEOUT_MS) {
      await sleep(7000);
      const info = JSON.parse(await pageProbe(page));
      const brief = `面板=${info.panel} 行数=${info.n} 已译=${info.translatedCount} 状态="${info.status}" 音频="${info.audioState}"`;
      if (brief !== lastInfo) { console.log('   ', brief, '| 原文:', JSON.stringify(info.origs.slice(-2))); lastInfo = brief; }
      if (info.n >= 2 && info.translatedCount >= 1) { passed = true; break; }
      if (info.status.startsWith('⚠')) { /* 出错也继续轮询一段时间，看是否会自动恢复或最终失败 */ }
    }

    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'result.png'), Buffer.from(shot.data, 'base64'));
    console.log('[6/6] 截图已保存 tests/e2e/result.png');

    if (!passed) {
      const info = JSON.parse(await pageProbe(page));
      throw new Error('FAIL：未在时限内出现 2 行以上字幕/译文。最终状态: ' + JSON.stringify(info, null, 2));
    }
    const info = JSON.parse(await pageProbe(page));
    console.log('\n================ PASS ================');
    console.log('面板出现:', info.panel);
    console.log('字幕行数:', info.n, '（含译文:', info.translatedCount, '行）');
    console.log('最近原文:', JSON.stringify(info.origs, null, 2));
    console.log('面板状态:', info.status);
    console.log('======================================');
  } finally {
    try { if (browser) await browser.send('Browser.close'); } catch (e) { /* 忽略 */ }
    try { if (sw) sw.close(); } catch (e) { /* 忽略 */ }
    try { if (page) page.close(); } catch (e) { /* 忽略 */ }
    try { if (browser) browser.close(); } catch (e) { /* 忽略 */ }
    await sleep(1500);
    try { proc.kill(); } catch (e) { /* 忽略 */ }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

main().then(() => process.exit(0), (e) => { console.error('\nFAIL:', e.message); process.exit(1); });
