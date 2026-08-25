// 弹窗控制：开始/停止、语言与模型设置、状态显示、诊断日志复制

const $ = (id) => document.getElementById(id);
let running = false;

async function init() {
  try {
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (e) { /* 版本号显示失败不影响功能 */ }
  const { srcLang, tgtLang, model, playAudio, dlSource, mode, trProvider, deeplKey, llmBaseUrl, llmKey, llmModel, streamContext, translateDetail, asrEngine, beamSearch, glossary } = await chrome.storage.local.get({
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
    beamSearch: false,
    glossary: '',
  });
  // 与 background 一致的一次性迁移：从未改过模型的老用户从 base 升到 turbo（base 日语精度差）
  let modelShown = model;
  try {
    const { asrModelMigrated } = await chrome.storage.local.get({ asrModelMigrated: false });
    if (!asrModelMigrated) {
      const patch = { asrModelMigrated: true };
      if (model === 'base') { modelShown = 'turbo'; patch.model = 'turbo'; }
      await chrome.storage.local.set(patch);
    }
  } catch (e) { /* 迁移失败不影响使用 */ }
  $('srcLang').value = srcLang;
  $('tgtLang').value = tgtLang;
  $('model').value = modelShown;
  $('playAudio').checked = playAudio;
  $('dlSource').value = dlSource;
  $('mode').value = mode;
  $('trProvider').value = trProvider;
  $('deeplKey').value = deeplKey;
  $('llmBaseUrl').value = llmBaseUrl;
  $('llmKey').value = llmKey;
  $('llmModel').value = llmModel;
  $('streamContext').value = streamContext;
  $('glossary').value = glossary;
  $('translateDetail').value = translateDetail;
  $('asrEngine').value = asrEngine;
  $('beamSearch').checked = beamSearch;
  syncProviderFields();
  syncAsrEngineFields();

  for (const id of ['srcLang', 'tgtLang', 'model', 'playAudio', 'dlSource', 'mode', 'trProvider', 'deeplKey', 'llmBaseUrl', 'llmKey', 'llmModel', 'streamContext', 'glossary', 'translateDetail', 'asrEngine', 'beamSearch']) {
    $(id).addEventListener('change', saveSettings);
  }
  $('trProvider').addEventListener('change', syncProviderFields);
  $('asrEngine').addEventListener('change', syncAsrEngineFields);
  $('toggleBtn').addEventListener('click', toggle);
  const diagBtn = $('diagBtn');
  if (diagBtn) diagBtn.addEventListener('click', copyDiag);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.state) renderState(changes.state.newValue);
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/([a-z0-9-]+\.)*youtube\.com\//i.test(tab.url || '')) {
    $('tabWarn').classList.remove('hidden');
  }

  await refresh();
}

function syncProviderFields() {
  const p = $('trProvider').value;
  $('deeplKey').classList.toggle('hidden', p !== 'deepl');
  $('llmBaseUrl').classList.toggle('hidden', p !== 'llm');
  $('llmKey').classList.toggle('hidden', p !== 'llm');
  $('llmModel').classList.toggle('hidden', p !== 'llm');
  $('streamContext').classList.toggle('hidden', p !== 'llm');
  $('glossary').classList.toggle('hidden', p !== 'llm');
  $('translateDetailRow').classList.toggle('hidden', p !== 'llm');
}

function syncAsrEngineFields() {
  const v = $('asrEngine').value;
  const usesCloud = v === 'cloud' || v === 'hybrid';
  $('cloudHint').classList.toggle('hidden', !usesCloud);
  $('modelRow').classList.toggle('hidden', v === 'cloud'); // 混合并行仍使用本地模型
  $('beamRow').classList.toggle('hidden', v === 'cloud');
}

function saveSettings() {
  chrome.storage.local.set({
    srcLang: $('srcLang').value,
    tgtLang: $('tgtLang').value,
    model: $('model').value,
    playAudio: $('playAudio').checked,
    dlSource: $('dlSource').value,
    mode: $('mode').value,
    trProvider: $('trProvider').value,
    deeplKey: $('deeplKey').value.trim(),
    llmBaseUrl: $('llmBaseUrl').value.trim(),
    llmKey: $('llmKey').value.trim(),
    llmModel: $('llmModel').value.trim(),
    streamContext: $('streamContext').value.trim(),
    glossary: $('glossary').value.trim(),
    translateDetail: $('translateDetail').value,
    asrEngine: $('asrEngine').value,
    beamSearch: $('beamSearch').checked,
  });
}

async function refresh() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'popup-get-state' });
    renderState(state);
  } catch (e) {
    renderState(null);
  }
}

function renderState(state) {
  if (state) running = !!state.running;
  $('toggleBtn').textContent = running ? '停止字幕' : '开始字幕';
  $('toggleBtn').classList.toggle('stopping', running);
  const hasError = !!(state && state.error);
  $('dot').className = running ? (hasError ? 'on err' : 'on') : (hasError ? 'err' : '');
  if (state && state.error) {
    $('statusText').textContent = '⚠ ' + state.error;
  } else if (state && state.status) {
    $('statusText').textContent = state.status;
  } else {
    $('statusText').textContent = running ? '运行中' : '未启动';
  }
  renderDiag();
}

// 诊断日志：出问题时点"复制诊断"发给支持即可（含最近 50 条引擎状态/错误与时间戳）
async function renderDiag() {
  const btn = $('diagBtn');
  if (!btn) return;
  try {
    const { diagLog } = await chrome.storage.local.get({ diagLog: [] });
    btn.style.display = Array.isArray(diagLog) && diagLog.length ? '' : 'none';
  } catch (e) { btn.style.display = 'none'; }
}

async function copyDiag() {
  try {
    const { diagLog } = await chrome.storage.local.get({ diagLog: [] });
    const text = (diagLog || []).map((d) => {
      const ts = new Date(d.t).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${ts}] ${d.s || ''}${d.e ? ' | 错误: ' + d.e : ''}`;
    }).join('\n');
    await navigator.clipboard.writeText(text || '（无诊断记录）');
    $('diagBtn').textContent = '✓ 已复制';
    setTimeout(() => { $('diagBtn').textContent = '⧉ 复制诊断'; }, 1600);
  } catch (e) {
    $('diagBtn').textContent = '复制失败';
  }
}

async function toggle() {
  const res = running
    ? await chrome.runtime.sendMessage({ type: 'popup-stop' })
    : await chrome.runtime.sendMessage({ type: 'popup-start' });
  if (res && res.error) {
    $('statusText').textContent = '⚠ ' + res.error;
  } else {
    await refresh();
  }
}

init();
