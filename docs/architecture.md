# 架构说明

本文面向贡献者，解释系统的运行模型、模块职责与几个关键设计决策。功能使用问题请看 [user-guide.md](user-guide.md)。

## 运行模型

MV3 扩展有四个执行环境，各跑一份代码：

```
popup (扩展弹窗)
   │ popup-start/stop、设置读写（chrome.storage.local）
   ▼
background (Service Worker)
   │ tabCapture.getMediaStreamId → ensureOffscreen → begin-capture(streamId, settings)
   ▼
offscreen (隐藏页 = 识别/翻译引擎，src/offscreen/)
   │ getUserMedia(tab) → 16kHz AudioContext → AudioWorklet 切段
   │ → 并发识别（本地 Whisper / 云端 / 混合）→ 清洗 → 句子拼装 → 翻译调度
   │ asr-line / asr-partial / asr-translated / offscreen-status
   ▼
background 路由 → content (YouTube 页面注入) → 字幕面板 / CC 字幕条上屏
```

要点：

- **streamId 有时效**：必须先接通音频（getUserMedia），再加载可能很耗时的模型
- **回放链路独立**：捕获时标签页自身静音，插件用独立默认采样率的 AudioContext 回放声音；识别链路走 16kHz 上下文，两者解耦
- **消息全部经 background 转发**（offscreen 无法直接给 content 发消息），background 对来源做 `sender.id === chrome.runtime.id` 校验

## offscreen 引擎模块

`src/offscreen/` 从单文件拆为职责单一的 ES 模块（函数名与迁移前保持一致，便于对照历史）：

| 模块 | 职责 | 关键导出 |
|------|------|----------|
| `engine-env.js` | transformers.js 的**唯一**引入入口 + 引擎版本号 | `pipeline` `env` `ENGINE_VERSION` |
| `bus.js` | 消息总线：状态上报、运行横幅管理 | `post` `postStatus` `postBanner` `getBannerStatus` |
| `index.js` | 编排层：消息监听、start/stop 会话、音频图、语音段队列、并发 worker、顺序门、句子拼装 | （入口，无导出） |
| `asr-local.js` | 本地 Whisper 管线工厂：方案组合（GPU 量化优先）、下载源探测、停滞看门狗、models/ 本地权重直读 | `createPipeline(cfg, modelKey, forceWasm, quiet)` |
| `asr-cloud.js` | 云端识别：WAV 编码 + OpenAI 风格 /audio/transcriptions | `makeCloudAsr(cfg)` `cloudTranscribe` |
| `asr-clean.js` | 识别文本清洗：噪声/幻觉黑名单、副歌放行的去重窗口、有声无字诊断 | `createAsrCleaner(onLoudEmpty)` `rmsOf` |
| `tr-llm.js` | 大模型翻译：提示词、SSE 流式、极简自愈、大意概括、拒绝检测 | `callLLMStream` `callLLMSimple` `callLLMParaphrase` `looksLikeRefusal` |
| `tr-google.js` | Google 免费翻译双通道 + 熔断 | `translateGoogle` `isGoogleDown` `tripGoogleBreaker` |
| `tr-deepl.js` | DeepL | `translateDeepL` |
| `tr-queue.js` | 翻译调度：攒批、精确缓存、上下文、多层自愈、失败可见化、单句重译 | `initTranslateQueue` `scheduleTranslate` `retryTranslate` `shutdownTranslate` |
| `worklet-processor.js` | AudioWorklet：固定低阈值语音判定、停顿切分、边界预滚动 | （独立上下文运行） |

**依赖注入约定**：业务模块不持有全局会话状态——`cfg`（本次会话设置）一律作为参数传入（`createPipeline(cfg, …)`、`callLLMStream(cfg, …)`）；`tr-queue` 因为内部有定时器与缓存，由 `index.js` 在每次 `start` 时 `initTranslateQueue(settings, isRunning)` 注入。这使得业务模块可以直接被 Node 单测 import。

## 关键设计决策

### 为什么音频切分用 AudioWorklet + 固定低阈值，而不是 Web Speech / 流式 ASR？

切分式（utterance-based）识别是浏览器栈的现实最优解：Whisper 对完整句的断句与同音字纠错远好于碎片；静音段在 worklet 里直接丢弃（RMS < 0.0035），从源头杜绝 Whisper 对纯静音的"感谢观看"幻觉。停顿 ≥0.35s 切段并携带 `pauseEnded` 标记，长句在停顿点立即上屏——这是延迟从 3~4s 压到 1~2s 的关键路径。1 秒以内的端到端延迟需要流式 ASR 架构，浏览器栈暂不具备。

### 为什么并发 worker + 顺序门（emitOrdered）？

GPU 双管线/混合多路并行时，各段完成顺序会颠倒。每段取递增流水号 `chunkSeq`，完成后进 `emitQ`，凑齐连续序号才放行进句子拼装器——保证字幕顺序与主播说话顺序一致，同时吞吐翻倍。GPU 持续满载积压时 `startScaleMonitor` 自动扩容到 3 路。

### 为什么 Google 翻译要双通道 + 熔断？

免费 gtx 接口按 IP 激进限流（429 + "Sorry..." 页）。clients5 的 dict-chrome-ex 备用接口限流池独立，双通道互为备份并记住上次成功的通道；双双失败则熔断 120 秒并给每行打"⚠ 译失败·点击重试"标记——绝不让译文停在无声的"…"上。

### 为什么歌词要走"无障碍字幕"框架 + 多层兜底？

大模型的版权策略会拒绝"逐句翻译歌词"。防线依次是：①系统提示词把任务定义为实时无障碍字幕（唱歌内容也必须可理解）；②`looksLikeRefusal` 拦截拒绝应答不上屏；③极简请求重试（绕开格式/参数兼容性问题）；④🎵 大意概括（版权策略几乎不拦"概括她在唱什么"）。识别层的另一问题（唱腔/BGM 下模型不出字）由 `createAsrCleaner` 的有声无字诊断明示——两个层面的"歌词没翻译"要分开处理。

### 为什么要物理版本化文件名（make-versioned）？

Chrome 对 chrome-extension:// 资源有顽固缓存：改了源码、重载扩展，仍可能拿到旧的 JS（包括动态 import 的 transformers.js）。已验证的规避手段是**物理改名**：`npm run bump` 把引擎模块打包成 `offscreen.vN.js`，连同 `engine.vN.html`、`worklet-processor.vN.js`、`transformers.vN.min.js` 一起生成版本化副本，`background` 启动时读 `engine-version.json` 选择最新入口。脚本会自动清理旧版本产物。

模块打包本身是零依赖的固定顺序拼接（`tools/lib/bundle-offscreen.cjs`）：剥掉模块间 import/export（拼接后共享作用域，与单文件时代语义一致），保留 engine-env 的 transformers 引入并替换为版本化路径。新增模块在 `ORDER` 数组登记即可。

### transformers.min.js 为什么要打补丁？

两处（`tools/get-libs.mjs` 自动完成）：

1. 运行库本地化：内置的 jsdelivr CDN 默认路径在 MV3 页面会被 CSP 拦截，替换为基于 `document.baseURI` 的 `../libs/` 本地绝对路径（引擎页在 `src/offscreen/` 子目录下，所以是 `../libs/`）
2. 3.8.1 的 `local_files_only` 读取缺默认值，可选文件 404 时抛 TypeError，改为可选链

### 模型权重的两条路径

- **浏览器 Cache API**（默认）：transformers.js 自动下载缓存，优点是零配置，缺点是占 C 盘且清缓存即失效
- **扩展目录直读**：`tools/download-model.ps1` 把权重下到 `src/models/<org>/<repo>/`，引擎探测到 `config.json` 即设 `env.allowLocalModels` 直读磁盘；个别 dtype 缺失自动回落远程补齐

## 测试体系

| 层级 | 位置 | 覆盖 |
|------|------|------|
| 单元测试（`npm test`） | `tests/*.test.mjs` | 翻译双通道/熔断（6）、LLM 链路真实 HTTP（8）、歌词拒绝检测（9）、ASR 清洗/副歌去重（8） |
| 手动断言页 | `tests/manual/` | 字幕面板收起/展开的 CSS 回归（复刻最难 DOM 场景，9 断言） |
| e2e 真实浏览器 | `tests/e2e/` | 带扩展的 Chrome + 真实音频播放 + mock LLM，断言面板/原文/译文全链路（需自备音频样本与手动点击触发） |

单元测试直接 `import` 真实模块（带查询串的动态 import 拿全新实例以隔离模块内状态），不再从源码抽取函数。
