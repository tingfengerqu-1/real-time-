// 字幕 UI：在 YouTube 页面上悬浮显示"原文 + 译文"。
// 支持：拖动、字号调节、显示模式（双语/仅中/仅日）、收起、清空、复制、导出 SRT、
// 回到底部、识别延迟与句数统计；位置/字号/模式跨会话记忆。

(() => {
  if (window.__ytlSubLoaded) return;
  window.__ytlSubLoaded = true;

  // 扩展重载后，旧脚本的面板会残留成"孤儿"（不再接收消息但仍在页面上），
  // 导致出现两个弹框。新实例启动时先清掉所有旧面板再建自己的。
  document.querySelectorAll('#ytl-sub-panel').forEach((el) => el.remove());

  const MAX_LINES = 200; // 完整优先模式下保留更长的字幕历史
  const MODE_LABEL = { both: '双语', zh: '仅中', ja: '仅日' };
  let panel = null;
  let linesEl = null;
  let statusEl = null;
  let latEl = null;
  let cntEl = null;
  let goBottomBtn = null;
  let collapsed = false;
  let displayMode = 'both';
  let paused = false;     // 识别暂停状态（面板按钮切换，引擎侧丢弃新语音段）
  let pauseBtnRef = null;
  let liveEl = null;      // "原文先行"实时行（拼装中的句子片段，成句后被正式行替换）
  let historyTimerStarted = false; // 历史字幕定时保存只启动一次
  let styleMode = 'panel'; // 显示样式：panel 悬浮面板 / cc 视频底部字幕条
  let ccEl = null;        // 字幕条根元素
  let ccOrigEl = null;    // 字幕条日文行
  let ccTransEl = null;   // 字幕条译文行
  let ccCurrentId = null; // 字幕条当前显示的行 id（用于译文原位更新与重译）
  let autoScroll = true;   // 用户滚到底部附近时自动跟随新字幕；上翻阅读历史时暂停跟随
  let lineCount = 0;
  const latSamples = [];   // 最近若干句"说完→上屏"延迟（毫秒）

  function savePrefs(patch) {
    const current = { ytlCollapsed: collapsed, ytlDisplayMode: displayMode, ...(window.__ytlPrefs || {}), ...patch };
    window.__ytlPrefs = current;
    try { chrome.storage.local.set(current); } catch (e) { /* 扩展已重载/卸载，残留实例作废 */ }
  }

  async function loadPrefs() {
    try {
      const got = await chrome.storage.local.get({ ytlCollapsed: false, ytlFontSize: 20, ytlPos: null, ytlDisplayMode: 'both', ytlOpacity: 1, ytlWidth: 0, ytlHeight: 0, ytlStyle: 'panel', ytlCcBottom: 70 });
      collapsed = got.ytlCollapsed;
      displayMode = ['both', 'zh', 'ja'].includes(got.ytlDisplayMode) ? got.ytlDisplayMode : 'both';
      styleMode = got.ytlStyle === 'cc' ? 'cc' : 'panel';
      window.__ytlPrefs = { ytlCollapsed: got.ytlCollapsed, ytlFontSize: got.ytlFontSize, ytlPos: got.ytlPos, ytlDisplayMode: displayMode, ytlOpacity: got.ytlOpacity, ytlWidth: got.ytlWidth, ytlHeight: got.ytlHeight, ytlStyle: styleMode, ytlCcBottom: got.ytlCcBottom };
    } catch (e) { /* 扩展已重载/卸载，残留实例作废 */ }
  }

  function ensurePanel() {
    if (panel && panel.isConnected) return;
    if (!panel) buildPanel();
    attachPanel();
  }

  // 全屏时必须把面板放进全屏元素内，否则不可见
  function attachPanel() {
    const host = document.fullscreenElement || document.body;
    if (!host) return;
    host.appendChild(panel);
    clampPosition();
  }

  // ---------- 视频底部字幕条（CC 样式）：一句接一句，下一句替换上一句 ----------

  function applyStyleMode(save) {
    if (!panel) return;
    if (styleMode === 'cc') {
      panel.style.display = 'none'; // 面板隐藏但后台继续运转（历史/导出/统计不受影响）
      ensureCc();
    } else {
      panel.style.display = '';
      if (ccEl) ccEl.style.display = 'none';
    }
    if (save) savePrefs({ ytlStyle: styleMode });
  }

  function ensureCc() {
    if (styleMode !== 'cc') return;
    if (!ccEl) buildCc();
    if (!ccEl.isConnected) {
      // 优先挂进播放器容器（跟随播放器尺寸/全屏），找不到则挂 body 用 fixed 定位
      const host = document.fullscreenElement || document.querySelector('#movie_player') || document.body;
      if (!host) return;
      host.appendChild(ccEl);
      ccEl.classList.toggle('ytl-cc-fixed', host === document.body);
    }
  }

  function buildCc() {
    ccEl = document.createElement('div');
    ccEl.id = 'ytl-cc';
    ccEl.dataset.mode = displayMode;
    ccEl.style.setProperty('--ytl-font-size', ((window.__ytlPrefs && window.__ytlPrefs.ytlFontSize) || 20) + 'px');
    const bottom = (window.__ytlPrefs && window.__ytlPrefs.ytlCcBottom) || 70;
    ccEl.style.bottom = bottom + 'px';

    ccOrigEl = document.createElement('div');
    ccOrigEl.className = 'ytl-cc-orig';
    ccTransEl = document.createElement('div');
    ccTransEl.className = 'ytl-cc-trans';
    ccTransEl.textContent = '';
    ccTransEl.title = '点击用大模型重新翻译这句';

    const ctl = document.createElement('button');
    ctl.className = 'ytl-cc-ctl';
    ctl.textContent = '☰';
    ctl.title = '切回悬浮面板（可看历史、导出 SRT）';
    ctl.addEventListener('click', (e) => {
      e.stopPropagation();
      styleMode = 'panel';
      applyStyleMode(true);
    });

    ccEl.append(ccOrigEl, ccTransEl, ctl);

    // 点击译文重译（与面板行一致）
    ccTransEl.addEventListener('click', () => {
      if (ccCurrentId != null && ccOrigEl.textContent) retryLine(ccTransEl, ccCurrentId, ccOrigEl.textContent);
    });

    // 垂直拖动调整字幕条高度位置
    ccEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const host = ccEl.parentElement || document.body;
      const rect = ccEl.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const startY = e.clientY;
      const startBottom = hostRect.bottom - rect.bottom;
      const move = (ev) => {
        const b = Math.max(8, Math.min(Math.round(hostRect.height - 20), startBottom + (ev.clientY - startY)));
        ccEl.style.bottom = b + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const r2 = ccEl.getBoundingClientRect();
        savePrefs({ ytlCcBottom: Math.round(hostRect.bottom - r2.bottom) });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  // 新句上条：旧句直接被替换（经典 CC 行为），带轻微上滑入场动画
  function setCcLine(id, text) {
    ensureCc();
    if (!ccEl) return;
    ccCurrentId = id;
    ccOrigEl.textContent = text || '';
    ccTransEl.textContent = '…';
    ccTransEl.dataset.retrying = '0';
    ccEl.classList.add('ytl-cc-has');
    ccEl.classList.remove('ytl-cc-in');
    void ccEl.offsetWidth; // 重启动画
    ccEl.classList.add('ytl-cc-in');
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'ytl-sub-panel';
    panel.dataset.mode = displayMode;

    const header = document.createElement('div');
    header.className = 'ytl-sub-header';

    const title = document.createElement('span');
    title.className = 'ytl-sub-title';
    title.innerHTML = '<i class="ytl-live-dot"></i>实时字幕';

    statusEl = document.createElement('span');
    statusEl.className = 'ytl-sub-status';

    latEl = document.createElement('span');
    latEl.className = 'ytl-sub-chip ytl-lat';
    latEl.title = '最近字幕从"主播说完"到"字幕上屏"的平均延迟';
    latEl.style.display = 'none';

    cntEl = document.createElement('span');
    cntEl.className = 'ytl-sub-chip ytl-cnt';
    cntEl.title = '本次已识别句数';
    cntEl.style.display = 'none';

    const btns = document.createElement('div');
    btns.className = 'ytl-sub-btns';
    const mkBtn = (label, fn, tip) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (tip) b.title = tip;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      btns.appendChild(b);
      return b;
    };
    const modeBtn = mkBtn(MODE_LABEL[displayMode], () => {
      displayMode = displayMode === 'both' ? 'zh' : displayMode === 'zh' ? 'ja' : 'both';
      panel.dataset.mode = displayMode;
      if (ccEl) ccEl.dataset.mode = displayMode; // 字幕条模式同步生效
      modeBtn.textContent = MODE_LABEL[displayMode];
      savePrefs({ ytlDisplayMode: displayMode });
    }, '切换显示：双语 / 仅中文 / 仅日文');
    let pauseBtn;
    pauseBtn = mkBtn(paused ? '继续' : '暂停', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? '继续' : '暂停';
      try { chrome.runtime.sendMessage({ type: 'set-paused', paused }); } catch (e) { /* 引擎未运行 */ }
    }, '暂停/继续识别（暂停时不出新字幕，声音不受影响）');
    pauseBtnRef = pauseBtn;
    mkBtn('A⁻', () => setFontSize(-2), '减小字号');
    mkBtn('A⁺', () => setFontSize(2), '增大字号');
    mkBtn('样式', () => {
      styleMode = styleMode === 'panel' ? 'cc' : 'panel';
      applyStyleMode(true);
    }, '切换显示样式：悬浮面板（滚动历史）/ 视频底部字幕条（像普通视频字幕，一句接一句）');
    const OPACITY_LEVELS = [1, 0.8, 0.6];
    const OPACITY_LABELS = ['不透明', '半透明', '高透明'];
    let opacityIdx = Math.max(0, OPACITY_LEVELS.indexOf(Number((window.__ytlPrefs && window.__ytlPrefs.ytlOpacity) || 1)));
    const applyOpacity = (v, save) => {
      panel.style.setProperty('--ytl-bg', String(v));
      if (save) savePrefs({ ytlOpacity: v });
    };
    const opacityBtn = mkBtn(OPACITY_LABELS[opacityIdx], () => {
      opacityIdx = (opacityIdx + 1) % OPACITY_LEVELS.length;
      applyOpacity(OPACITY_LEVELS[opacityIdx], true);
      opacityBtn.textContent = OPACITY_LABELS[opacityIdx];
    }, '循环切换面板背景透明度');
    applyOpacity(OPACITY_LEVELS[opacityIdx], false);
    applyStyleMode(false);
    mkBtn('SRT', exportSrt, '导出为 SRT 字幕文件（含时间戳与双语）');
    mkBtn('⧉', copyAll, '复制全部字幕（原文+译文）到剪贴板');
    mkBtn('↺', restoreHistory, '恢复上次会话的字幕（停止/刷新后仍可导出 SRT）');
    mkBtn('清空', () => {
      linesEl.textContent = '';
      lineCount = 0;
      liveEl = null;
      updateChips();
    }, '清空当前字幕');
    let collapseBtn;
    collapseBtn = mkBtn(collapsed ? '展开' : '收起', () => {
      collapsed = !collapsed;
      panel.classList.toggle('ytl-collapsed', collapsed);
      collapseBtn.textContent = collapsed ? '展开' : '收起';
      savePrefs({ ytlCollapsed: collapsed });
    }, '收起/展开字幕面板');

    header.append(title, statusEl, latEl, cntEl, btns);

    const body = document.createElement('div');
    body.className = 'ytl-sub-body';

    linesEl = document.createElement('div');
    linesEl.className = 'ytl-sub-lines';
    linesEl.addEventListener('scroll', () => {
      const nearBottom = linesEl.scrollHeight - linesEl.scrollTop - linesEl.clientHeight < 60;
      autoScroll = nearBottom;
      goBottomBtn.classList.toggle('ytl-show', !nearBottom);
    });
    wireLineEvents();

    goBottomBtn = document.createElement('button');
    goBottomBtn.className = 'ytl-sub-gobottom';
    goBottomBtn.textContent = '↓ 最新';
    goBottomBtn.title = '回到最新字幕';
    goBottomBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      autoScroll = true;
      goBottomBtn.classList.remove('ytl-show');
      linesEl.scrollTop = linesEl.scrollHeight;
    });

    body.append(linesEl, goBottomBtn);

    // 边框自由拉伸：四边 + 四角共 8 个手柄，宽高皆可调
    const RZ_HANDLES = [
      ['n', 'ytl-rz-n'], ['s', 'ytl-rz-s'], ['e', 'ytl-rz-e'], ['w', 'ytl-rz-w'],
      ['ne', 'ytl-rz-ne'], ['nw', 'ytl-rz-nw'], ['se', 'ytl-rz-se'], ['sw', 'ytl-rz-sw'],
    ];
    for (const [dir, cls] of RZ_HANDLES) {
      const h = document.createElement('div');
      h.className = 'ytl-rz ' + cls;
      h.title = '拖动调整面板大小';
      h.addEventListener('pointerdown', (e) => startResize(e, dir));
      panel.appendChild(h);
    }
    panel.append(header, body);

    if (collapsed) panel.classList.add('ytl-collapsed');
    const fontSize = (window.__ytlPrefs && window.__ytlPrefs.ytlFontSize) || 20;
    panel.style.setProperty('--ytl-font-size', fontSize + 'px');

    header.addEventListener('pointerdown', startDrag);
  }

  function setFontSize(delta) {
    const current = parseFloat(panel.style.getPropertyValue('--ytl-font-size')) || 20;
    const next = Math.max(12, Math.min(40, current + delta));
    panel.style.setProperty('--ytl-font-size', next + 'px');
    savePrefs({ ytlFontSize: next });
  }

  function defaultPosition() {
    const saved = window.__ytlPrefs && window.__ytlPrefs.ytlWidth;
    const width = Math.max(320, Math.min(760, saved || Math.min(760, Math.floor(window.innerWidth * 0.9))));
    panel.style.width = width + 'px';
    // 用户拉过高度：固定高度模式，字幕区 flex 填满
    const savedH = (window.__ytlPrefs && window.__ytlPrefs.ytlHeight) || 0;
    if (savedH >= 120) {
      panel.style.height = savedH + 'px';
      panel.classList.add('ytl-sized');
    }
    panel.style.left = Math.floor((window.innerWidth - width) / 2) + 'px';
    panel.style.top = Math.floor(window.innerHeight * 0.62) + 'px';
  }

  function clampPosition() {
    const rect = panel.getBoundingClientRect();
    if (!rect.width) return;
    let x = rect.left;
    let y = rect.top;
    x = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - Math.min(rect.height, window.innerHeight * 0.9) - 8));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  }

  function restorePosition() {
    const pos = window.__ytlPrefs && window.__ytlPrefs.ytlPos;
    defaultPosition();
    if (pos) {
      panel.style.left = pos[0] + 'px';
      panel.style.top = pos[1] + 'px';
      clampPosition();
    }
  }

  function startDrag(e) {
    if (e.target.closest('button')) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    const move = (ev) => {
      let x = ev.clientX - offX;
      let y = ev.clientY - offY;
      x = Math.max(0, Math.min(x, window.innerWidth - rect.width));
      y = Math.max(0, Math.min(y, window.innerHeight - 40));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const r = panel.getBoundingClientRect();
      savePrefs({ ytlPos: [Math.round(r.left), Math.round(r.top)] });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // 边框拉伸：dir 含 n/s/e/w 任意组合；拖动对侧边固定，最小尺寸与视口边界钳制
  function startResize(e, dir) {
    e.preventDefault();
    e.stopPropagation();
    const rect = panel.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = { l: rect.left, t: rect.top, w: rect.width, h: rect.height };
    const MIN_W = 320;
    const MIN_H = 120;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let l = start.l, t = start.t, w = start.w, h = start.h;
      if (dir.includes('w')) {
        const right = start.l + start.w; // 右边固定
        w = start.w - dx;
        if (w < MIN_W) w = MIN_W;
        if (start.l + start.w - w < 0) w = right; // 不许拖出左边界
        l = right - w;
      }
      if (dir.includes('n')) {
        const bottom = start.t + start.h; // 底边固定
        h = start.h - dy;
        if (h < MIN_H) h = MIN_H;
        if (start.t + start.h - h < 0) h = bottom;
        t = bottom - h;
      }
      if (dir.includes('e')) {
        w = Math.max(MIN_W, Math.min(start.w + dx, window.innerWidth - start.l - 8));
      }
      if (dir.includes('s')) {
        h = Math.max(MIN_H, Math.min(start.h + dy, window.innerHeight - start.t - 8));
      }
      panel.style.left = Math.round(l) + 'px';
      panel.style.top = Math.round(t) + 'px';
      panel.style.width = Math.round(w) + 'px';
      if (dir.includes('n') || dir.includes('s')) {
        panel.style.height = Math.round(h) + 'px';
        panel.classList.add('ytl-sized'); // 固定高度模式：字幕区 flex 填满
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const r = panel.getBoundingClientRect();
      savePrefs({
        ytlWidth: Math.round(r.width),
        ytlHeight: Math.round(r.height),
        ytlPos: [Math.round(r.left), Math.round(r.top)],
      });
      clampPosition();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---------- 字幕导出与复制 ----------

  function fmtSrtTime(ms) {
    const p = (n, l = 2) => String(Math.max(0, Math.floor(n))).padStart(l, '0');
    return `${p(ms / 3600000)}:${p((ms / 60000) % 60)}:${p((ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  }

  function collectRows() {
    return [...linesEl.querySelectorAll('.ytl-sub-line[data-ts]')]
      .map((el) => ({
        ts: Number(el.dataset.ts),
        orig: (el.querySelector('.ytl-sub-orig') || {}).textContent || '',
        trans: (el.querySelector('.ytl-sub-trans') || {}).textContent || '',
      }))
      .filter((r) => r.orig);
  }

  function exportSrt() {
    const rows = collectRows();
    if (!rows.length) {
      setStatus('暂无可导出的字幕', '');
      setTimeout(() => setStatus('', ''), 2500);
      return;
    }
    const base = rows[0].ts;
    const srt = rows
      .map((r, i) => {
        const start = r.ts - base;
        const end = rows[i + 1] ? rows[i + 1].ts - base : start + 4000;
        const body = r.trans && r.trans !== '…' ? `${r.orig}\n${r.trans}` : r.orig;
        return `${i + 1}\n${fmtSrtTime(start)} --> ${fmtSrtTime(Math.max(end, start + 1000))}\n${body}\n`;
      })
      .join('\n');
    const blob = new Blob(['\ufeff' + srt], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = `字幕_${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus(`已导出 ${rows.length} 条字幕`, '');
    setTimeout(() => setStatus('', ''), 2500);
  }

  async function copyAll() {
    const rows = collectRows();
    if (!rows.length) {
      setStatus('暂无可复制的字幕', '');
      setTimeout(() => setStatus('', ''), 2500);
      return;
    }
    const text = rows.map((r) => (r.trans && r.trans !== '…' ? `${r.orig}\n${r.trans}` : r.orig)).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`已复制 ${rows.length} 条字幕`, '');
    } catch (e) {
      setStatus('复制失败（浏览器剪贴板权限）', '');
    }
    setTimeout(() => setStatus('', ''), 2500);
  }

  // ---------- 统计角标 ----------

  function updateChips() {
    if (cntEl) {
      cntEl.style.display = lineCount ? '' : 'none';
      cntEl.textContent = lineCount + ' 句';
    }
    if (latEl && latSamples.length) {
      const avg = latSamples.reduce((a, b) => a + b, 0) / latSamples.length;
      latEl.style.display = '';
      latEl.textContent = '⏱ ' + (avg / 1000).toFixed(1) + 's';
      latEl.classList.toggle('ytl-lat-ok', avg < 4000);
      latEl.classList.toggle('ytl-lat-warn', avg >= 4000 && avg < 8000);
      latEl.classList.toggle('ytl-lat-bad', avg >= 8000);
    } else if (latEl) {
      latEl.style.display = 'none';
    }
  }

  // ---------- 原文先行（实时片段）与历史持久化 ----------

  function clearPartial() {
    if (liveEl) { liveEl.remove(); liveEl = null; }
  }

  // 拼装中的句子片段先实时显示原文（无 id，成句后由正式行替换）
  function showPartial(text) {
    ensurePanel();
    restoreIfNeeded();
    if (!liveEl) {
      liveEl = document.createElement('div');
      liveEl.className = 'ytl-sub-line ytl-live';
      const o = document.createElement('div');
      o.className = 'ytl-sub-orig';
      const tr = document.createElement('div');
      tr.className = 'ytl-sub-trans';
      tr.textContent = '…';
      liveEl.append(o, tr);
      linesEl.appendChild(liveEl);
    }
    liveEl.querySelector('.ytl-sub-orig').textContent = text;
    scrollFollow();
    // 字幕条模式：原文先行同样实时显示（译文位先占 "…"，成句后被正式句替换）
    if (styleMode === 'cc') {
      ensureCc();
      if (ccEl) {
        ccCurrentId = null;
        ccOrigEl.textContent = text;
        ccTransEl.textContent = '…';
        ccEl.classList.add('ytl-cc-has');
      }
    }
  }

  // 定期/停止时把字幕存到本地，停止或刷新后仍可"↺"恢复并导出 SRT
  function saveHistory() {
    const rows = collectRows().map((r) => ({ ts: r.ts, orig: r.orig, trans: r.trans === '…' ? '' : r.trans }));
    if (!rows.length) return;
    try { chrome.storage.local.set({ ytlHistory: rows.slice(-400), ytlSavedAt: Date.now() }); } catch (e) { /* 扩展已重载 */ }
  }

  function restoreHistory() {
    ensurePanel();
    restoreIfNeeded();
    chrome.storage.local.get({ ytlHistory: [], ytlSavedAt: 0 })
      .then((got) => {
        const rows = got.ytlHistory || [];
        if (!rows.length) {
          setStatus('没有可恢复的历史字幕', '');
          setTimeout(() => setStatus('', ''), 2500);
          return;
        }
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          const line = document.createElement('div');
          line.className = 'ytl-sub-line';
          line.dataset.id = 'h' + i;
          line.dataset.ts = r.ts || Date.now();
          const orig = document.createElement('div');
          orig.className = 'ytl-sub-orig';
          orig.textContent = r.orig || '';
          const trans = document.createElement('div');
          trans.className = 'ytl-sub-trans';
          trans.textContent = r.trans || '…';
          trans.title = '点击用大模型重新翻译这句';
          line.append(orig, trans);
          linesEl.appendChild(line);
        }
        while (linesEl.children.length > MAX_LINES) linesEl.firstChild.remove();
        lineCount = rows.length;
        updateChips();
        const d = new Date(got.ytlSavedAt || Date.now());
        const p = (n) => String(n).padStart(2, '0');
        setStatus(`已恢复 ${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} 的 ${rows.length} 句，可导出/复制`, '');
        setTimeout(() => setStatus('', ''), 4000);
        linesEl.scrollTop = linesEl.scrollHeight;
      })
      .catch(() => { /* 扩展已重载 */ });
  }

  // ---------- 字幕行 ----------

  function scrollFollow() {
    if (autoScroll) linesEl.scrollTop = linesEl.scrollHeight;
  }

  // 单句重译（事件委托：正式行与恢复的历史行都生效）
  function retryLine(transEl, id, origText) {
    if (transEl.dataset.retrying === '1') return;
    transEl.dataset.retrying = '1';
    const prev = transEl.textContent;
    transEl.textContent = '⟳ 重译中…';
    try {
      chrome.runtime.sendMessage({ type: 'retry-translate', id, text: origText });
    } catch (err) {
      transEl.textContent = prev;
      transEl.dataset.retrying = '0';
      return;
    }
    // 新译文到达会覆盖文本；15 秒未回则还原，避免卡在"重译中"
    setTimeout(() => {
      if (transEl.textContent === '⟳ 重译中…') {
        transEl.textContent = prev;
        transEl.dataset.retrying = '0';
      }
    }, 15000);
  }

  function wireLineEvents() {
    linesEl.addEventListener('click', (e) => {
      const transEl = e.target.closest('.ytl-sub-trans');
      if (!transEl) return;
      const line = transEl.closest('.ytl-sub-line');
      const orig = line && line.querySelector('.ytl-sub-orig');
      if (line && line.dataset.id != null && orig) {
        e.stopPropagation();
        retryLine(transEl, line.dataset.id, orig.textContent);
      }
    });
  }

  function addLine(id, text, ts, lat) {
    ensurePanel();
    restoreIfNeeded();
    clearPartial();
    const when = ts || Date.now();
    const line = document.createElement('div');
    line.className = 'ytl-sub-line';
    line.dataset.id = id;
    line.dataset.ts = when;
    const t = new Date(when);
    const p = (n) => String(n).padStart(2, '0');
    line.title =
      `出现于 ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}` +
      (typeof lat === 'number' && lat >= 0 ? `，上屏延迟 ${(lat / 1000).toFixed(1)} 秒` : '') +
      '；点击译文可重新翻译';

    const orig = document.createElement('div');
    orig.className = 'ytl-sub-orig';
    orig.textContent = text;

    const trans = document.createElement('div');
    trans.className = 'ytl-sub-trans';
    trans.textContent = '…';
    trans.title = '点击用大模型重新翻译这句';

    line.append(orig, trans);
    linesEl.appendChild(line);
    while (linesEl.children.length > MAX_LINES) linesEl.firstChild.remove();
    lineCount++;
    if (typeof lat === 'number' && lat >= 0) {
      latSamples.push(lat);
      if (latSamples.length > 20) latSamples.shift();
    }
    updateChips();
    scrollFollow();
    if (styleMode === 'cc') setCcLine(id, text); // 字幕条模式：镜像显示当前句
    if (!historyTimerStarted) {
      historyTimerStarted = true;
      setInterval(saveHistory, 20000); // 页面存续期间定时落盘，停止/崩溃后也能恢复
    }
  }

  function updateLine(id, text) {
    const el = linesEl && linesEl.querySelector(`[data-id="${id}"] .ytl-sub-trans`);
    if (el) {
      el.textContent = text;
      el.dataset.retrying = '0';
      el.classList.remove('ytl-flash');
      void el.offsetWidth; // 重启动画
      el.classList.add('ytl-flash');
      scrollFollow();
    }
    // 字幕条模式：译文原位更新当前句
    if (styleMode === 'cc' && ccTransEl && id === ccCurrentId) {
      ccTransEl.textContent = text;
      ccTransEl.dataset.retrying = '0';
    }
  }

  function setStatus(status, error) {
    ensurePanel();
    restoreIfNeeded();
    statusEl.textContent = error ? ('⚠ ' + error) : (status || '');
    statusEl.title = error ? ('⚠ ' + error) : (status || ''); // 悬停可看全文，避免省略号截断误导排查
    statusEl.classList.toggle('ytl-sub-error', !!error);
    statusEl.classList.toggle('ytl-sub-busy', !error && !!status);
  }

  let positionRestored = false;
  function restoreIfNeeded() {
    if (positionRestored) return;
    positionRestored = true;
    restorePosition();
  }

  document.addEventListener('fullscreenchange', () => {
    if (panel) attachPanel();
    if (styleMode === 'cc') ensureCc(); // 全屏切换后字幕条重新挂载
  });
  window.addEventListener('resize', () => {
    if (panel && panel.isConnected) clampPosition();
  });

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'asr-line') addLine(msg.id, msg.text, msg.ts, msg.lat);
      else if (msg.type === 'asr-partial') showPartial(msg.text);
      else if (msg.type === 'asr-translated') updateLine(msg.id, msg.text);
      else if (msg.type === 'status-update') setStatus(msg.status, msg.error);
      else if (msg.type === 'capture-stopped') {
        clearPartial();
        saveHistory();
        paused = false;
        if (pauseBtnRef) pauseBtnRef.textContent = '暂停';
        setStatus('已停止', '');
      }
    });
  } catch (e) {
    return; // 扩展已重载，本实例是残留脚本，直接退出
  }

  loadPrefs();
})();
