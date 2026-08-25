// 后台服务：发起/停止标签页音频捕获，并在 offscreen 识别页面与页面字幕 UI 之间转发消息。

// 引擎页地址：默认源码版 offscreen/engine.html；运行过 `npm run version`（tools/make-versioned.cjs）
// 后优先物理版本化文件 engine.vN.html——Chrome 对扩展资源有顽固缓存，物理改名是已验证的规避手段。
// 版本化文件名记录在 engine-version.json（构建产物，不入库），这里启动时探测一次。
let engineUrlCache = '';
async function offscreenUrl() {
  if (engineUrlCache) return engineUrlCache;
  engineUrlCache = 'offscreen/engine.html';
  try {
    const res = await fetch(chrome.runtime.getURL('offscreen/engine-version.json'), { cache: 'no-store' });
    if (res.ok) {
      const j = await res.json();
      if (j && j.html) engineUrlCache = 'offscreen/' + j.html;
    }
  } catch (e) { /* 无版本化产物（全新克隆未构建）：用源码版入口 */ }
  return engineUrlCache;
}

async function getState() {
  const { state } = await chrome.storage.session.get('state');
  return state || { running: false, tabId: null, status: '', error: '' };
}

async function setState(patch) {
  const state = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ state });
  return state;
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  try {
    await chrome.offscreen.createDocument({
      url: await offscreenUrl(),
      // AUDIO_PLAYBACK 必须声明：回放标签页声音需要音频输出权限，否则 offscreen 文档可能被静音
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: '捕获当前标签页音频用于实时语音识别，并回放声音保证用户正常收听',
    });
  } catch (e) {
    if (!String(e && e.message || e).includes('Only a single offscreen document may be created')) throw e;
  }
}

// urlHint：当调用方（如自动化测试）因权限拿不到 tab.url 时提供的兜底地址，弹窗路径无需传入
async function startCapture(explicitTabId = null, urlHint = '') {
  const state = await getState();
  if (state.running) return { ok: false, error: '已在运行中，请先停止' };

  let tab = null;
  if (explicitTabId != null) {
    try { tab = await chrome.tabs.get(explicitTabId); } catch (e) { /* 标签页可能已关闭 */ }
  }
  if (!tab) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab || tab.id == null) return { ok: false, error: '找不到当前标签页' };

  const tabUrl = tab.url || urlHint || '';
  const isYouTube = /^https:\/\/([a-z0-9-]+\.)*youtube\.com\//i.test(tabUrl);
  const isLocalDebug = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(tabUrl);
  if (!isYouTube && !isLocalDebug) {
    return { ok: false, error: '请先切换到 YouTube 标签页再开始' };
  }

  // 确保字幕脚本已注入（覆盖页面未刷新、SPA 内导航等场景，避免"面板不出现"）
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] });
  } catch (e) { /* 已注入或无权限时忽略 */ }

  await ensureOffscreen();

  const { srcLang, tgtLang, model, playAudio, dlSource, mode, trProvider, deeplKey, llmBaseUrl, llmKey, llmModel, streamContext, translateDetail, asrEngine, asrCloudModel, beamSearch, glossary } = await chrome.storage.local.get({
    srcLang: 'ja',
    tgtLang: 'zh-CN',
    model: 'turbo',
    playAudio: true,
    dlSource: 'auto',
    mode: 'complete',
    trProvider: 'google',
    deeplKey: '',
    llmBaseUrl: '',
    llmKey: '',
    llmModel: '',
    streamContext: '',
    translateDetail: 'quality',
    asrEngine: 'local',
    asrCloudModel: 'glm-asr-2512',
    beamSearch: false,
    glossary: '',
  });

  // 一次性迁移：老版本默认 base 模型对日语精度很差；升级后自动切到 turbo。
  // 用迁移标记区分"从没改过"与"手动选了 base"，尊重用户后续的手动选择
  const { asrModelMigrated } = await chrome.storage.local.get({ asrModelMigrated: false });
  let modelEff = model;
  if (!asrModelMigrated) {
    const patch = { asrModelMigrated: true };
    if (model === 'base') {
      modelEff = 'turbo';
      patch.model = 'turbo';
    }
    await chrome.storage.local.set(patch);
  }

  if ((asrEngine === 'cloud' || asrEngine === 'hybrid') && !String(llmKey || '').trim()) {
    return { ok: false, error: (asrEngine === 'hybrid' ? '混合并行' : '云端识别') + '需要 API Key：请在"翻译服务"选大模型 API 并填写智谱 Key' };
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (e) {
    return { ok: false, error: '获取音频失败：' + (e.message || e) };
  }

  await chrome.runtime.sendMessage({
    type: 'begin-capture',
    streamId,
    settings: { srcLang, tgtLang, model: modelEff, playAudio, dlSource, mode, trProvider, deeplKey, llmBaseUrl, llmKey, llmModel, streamContext, translateDetail, asrEngine, asrCloudModel, beamSearch, glossary },
  });

  await setState({ running: true, tabId: tab.id, status: '正在初始化…', error: '' });
  return { ok: true };
}

async function stopCapture(notifyTab = true) {
  try { await chrome.runtime.sendMessage({ type: 'end-capture' }); } catch (e) { /* offscreen 可能已关闭 */ }
  if (await hasOffscreen()) {
    try { await chrome.offscreen.closeDocument(); } catch (e) { /* 已关闭 */ }
  }
  const state = await setState({ running: false, status: '', error: '' });
  if (notifyTab && state.tabId != null) {
    try { await chrome.tabs.sendMessage(state.tabId, { type: 'capture-stopped' }); } catch (e) { /* 页面可能已关闭 */ }
  }
  return { ok: true };
}

async function relayToTab(msg) {
  const state = await getState();
  if (state.tabId != null) {
    try { await chrome.tabs.sendMessage(state.tabId, msg); } catch (e) { /* 页面可能已关闭 */ }
  }
}

// 快捷键（Ctrl+Shift+Y）开关字幕；快捷键属用户手势，可激活 activeTab 用于音频捕获
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-capture') return;
  (async () => {
    try {
      const state = await getState();
      const res = state.running ? await stopCapture() : await startCapture();
      if (res && res.error) console.warn('快捷键操作失败:', res.error);
    } catch (e) {
      console.warn('快捷键处理异常:', e);
    }
  })();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 消息来源校验（纵深防御）：本扩展运行时消息只应来自自身页面/内容脚本，
  // 拒绝异常来源，避免页面环境伪造消息操控捕获与设置
  if (!msg || sender.id !== chrome.runtime.id) {
    try { sendResponse({ ok: false, error: 'unauthorized sender' }); } catch (e) { /* 端口已关 */ }
    return;
  }
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'popup-start':
          sendResponse(await startCapture());
          break;
        case 'popup-stop':
          sendResponse(await stopCapture());
          break;
        case 'popup-get-state':
          sendResponse(await getState());
          break;
        case 'offscreen-status': {
          await setState({ status: msg.status || '', error: msg.error || '' });
          await relayToTab({ type: 'status-update', status: msg.status || '', error: msg.error || '' });
          // 诊断日志持久化：状态/错误落盘（上限 50 条），浏览器重启后仍可读取——
          // 排查"下载失败但拿不到错误原文"的远程支持场景全靠它
          if (msg.status || msg.error) {
            try {
              const { diagLog } = await chrome.storage.local.get({ diagLog: [] });
              diagLog.push({ t: Date.now(), s: String(msg.status || '').slice(0, 300), e: String(msg.error || '').slice(0, 600) });
              await chrome.storage.local.set({ diagLog: diagLog.slice(-50) });
            } catch (e) { /* session 满等边缘情况不影响主流程 */ }
          }
          sendResponse({ ok: true });
          break;
        }
        case 'asr-line':
        case 'asr-partial':
        case 'asr-translated':
          await relayToTab(msg);
          sendResponse({ ok: true });
          break;
        case 'retry-translate':
        case 'set-paused':
          // 面板发起：转发给 offscreen 引擎处理
          try { await chrome.runtime.sendMessage(msg); } catch (e) { /* offscreen 未运行 */ }
          sendResponse({ ok: true });
          break;
        case 'capture-ended': {
          // 非用户主动停止（例如被捕获的标签页被关闭/导航）
          const s = await getState();
          if (s.running) {
            await stopCapture(false);
            await setState({ status: '', error: msg.reason ? ('已停止：' + msg.reason) : '' });
          }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // 异步响应
});
