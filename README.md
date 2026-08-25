# Real-Time · YouTube 实时翻译字幕（Chrome 扩展）

看 YouTube 直播听不懂？这个扩展实时识别直播/视频里的语音（本地 Whisper，音频不出浏览器），翻译成中文，以双语悬浮字幕或视频底部 CC 字幕条显示，支持导出 SRT。

## 功能特性

- **三种识别引擎**：本地 Whisper（免费离线，WebGPU 加速、多管线并行、自动扩容）/ 云端 GLM-ASR（LLM 级抗噪，对游戏音效/BGM 混杂音频明显更准）/ **混合并行**（本地 + 云端多路同时跑，谁先空谁接活）
- **三档翻译**：大模型 API（OpenAI 兼容，流式逐句上屏、上下文意译、术语表）/ Google 免费翻译（主备双通道自动切换）/ DeepL
- **歌词友好**：无障碍字幕提示词框架 + 拒绝检测 + 极简重试 + 🎵 大意概括兜底，唱歌段落绝不留空
- **双字幕样式**：悬浮面板（拖动/四边拉伸/字号/透明度/双语切换/SRT 导出/历史恢复）与视频底部 CC 字幕条
- **低延迟链路**：原文先行显示、停顿即切句、流式翻译逐句上屏、翻译精确缓存、GPU 双管线
- **可观测性**：说完→上屏延迟统计、诊断日志持久化（一键复制）、失败可见化（限流熔断/自动降级/点击重试）

## 架构总览

```
┌─ popup/        控制弹窗：引擎/模型/翻译服务配置，状态与诊断
│
├─ background/   Service Worker：tabCapture 发起、offscreen 生命周期、消息路由、诊断落盘
│
├─ content/      字幕 UI（注入 YouTube 页面）：悬浮面板 + CC 字幕条、SRT 导出、历史恢复
│
└─ offscreen/    识别与翻译引擎（隐藏页，模块化拆分）
    ├─ index.js        编排层：会话生命周期、音频图、并发 worker、顺序门、句子拼装
    ├─ engine-env.js   transformers.js 唯一引入入口 + 引擎版本
    ├─ bus.js          消息总线（状态上报/横幅管理）
    ├─ asr-local.js    本地 Whisper 管线（方案组合/下载源探测/看门狗/本地权重直读）
    ├─ asr-cloud.js    云端识别（WAV 编码 + /audio/transcriptions）
    ├─ asr-clean.js    识别文本清洗（噪声/幻觉拦截、副歌放行、有声无字诊断）
    ├─ tr-llm.js       大模型翻译（提示词、SSE 流式、极简自愈、大意概括、拒绝检测）
    ├─ tr-google.js    Google 双通道 + 熔断
    ├─ tr-deepl.js     DeepL
    ├─ tr-queue.js     翻译调度（攒批/缓存/上下文/多层自愈/失败可见化）
    └─ worklet-processor.js  音频切分（AudioWorklet：静音检测、停顿切分、边界预滚动）
```

消息流：`worklet 切段 → index 并发识别 → asr-clean 清洗 → 句子拼装 → tr-queue 翻译 → background 路由 → content 上屏`。详见 [docs/architecture.md](docs/architecture.md)。

## 快速开始（源码运行）

前置：Node.js ≥ 18（构建/测试用），Chrome ≥ 116。

```bash
npm install          # 安装 terser（打包用）
npm run get-libs     # 下载推理运行库三件套到 src/libs/（约 23MB，一次性）
```

1. Chrome 打开 `chrome://extensions`，开启右上角**开发者模式**
2. **加载已解压的扩展程序** → 选择本项目的 `src/` 目录
3. 打开 YouTube 直播页 → 点扩展图标 → 配置翻译服务 → **开始字幕**

> 首次使用本地识别会自动下载模型权重（turbo 约 1.6GB，存于浏览器缓存）。
> 想把权重放到指定盘符/随项目目录管理，见下文"本地模型自定义路径"。


## 翻译服务配置

| 服务 | 质量 | 配置 |
|------|------|------|
| Google 免费翻译 | 一般 | 无需配置（gtx + clients5 双通道自动切换；双双限流时暂停 2 分钟并提示） |
| DeepL | 高 | [deepl.com](https://www.deepl.com) 免费注册拿 Key（每月 50 万字符） |
| 大模型 API | 最好 | OpenAI 兼容 Base URL + Key + 模型名

- **云端/混合识别**复用大模型 API 的 Base URL 与 Key（智谱 GLM-ASR）
- **术语表**：每行 `原文=中文译名`（人名/游戏名/称呼），全篇一致
- **直播背景描述**：写清主播/游戏/称呼等背景，翻译显著更准
- API Key 仅保存在本地 `chrome.storage`，不进入任何代码与构建产物
- 修改设置后需**停止并重新开始**生效

## 本地模型自定义路径

默认模型缓存在 Chrome 配置目录（C 盘）。想让权重随项目文件夹存放在任意盘符：

```powershell
powershell -ExecutionPolicy Bypass -File tools/download-model.ps1              # turbo + GPU(fp16) + CPU(q8) 权重
powershell -ExecutionPolicy Bypass -File tools/download-model.ps1 -Dtypes fp16 # 只下 GPU 权重（体积最小）
```

权重落在 `src/models/<org>/<repo>/`；重新加载扩展后，启动识别时状态栏显示「本地权重」即生效（不再下载、不占浏览器缓存）。

## 隐私

- 无统计、无埋点、无后端服务器，不收集任何用户数据
- 本地识别模式下音频不离开设备；云端识别仅发往你自己配置的 API 地址
- 翻译仅发送识别出的文字；API Key 仅保存在本地浏览器

## 常见问题

- **识别不准/杂谈不出字**：优先换"混合并行"或"云端"引擎；本地引擎确认模型为 turbo；BGM 大的唱见直播是本地模型的能力边界
- **模型加载失败/长时间停在加载**：把"模型下载源"切为国内镜像；错误详情悬停状态栏可看全文，或点弹窗"⧉ 复制诊断"
- **Google 翻译全空**：免费接口按 IP 限流（429），双通道都挂时自动熔断 2 分钟——建议切大模型翻译
- **听不到声音**：保持"回放标签页声音"勾选（捕获时标签页自身静音，由插件回放）；双重声音则取消勾选
- **字幕滞后**：看面板延迟角标——绿色（<4s）正常；持续红色换小模型/实时优先/混合引擎
- **改了代码没生效**：Chrome 对扩展资源缓存顽固，运行 `npm run bump` 生成物理版本化文件名（机制见架构文档）

## 目录结构

```
real-time/
├── src/                  可直接加载的扩展源码（manifest 在此）
│   ├── manifest.json
│   ├── background/       Service Worker
│   ├── content/          字幕 UI（JS/CSS）
│   ├── popup/            控制弹窗（HTML/CSS/JS）
│   ├── offscreen/        识别与翻译引擎（模块化，见架构文档）
│   ├── icons/            图标
│   ├── libs/             推理运行库（npm run get-libs 下载，不入库）
│   └── models/           本地模型权重（可选，不入库）
├── tools/                构建与运维脚本（打包/版本化/运行库/模型下载）
├── tests/                单元测试 + 手动断言页 + e2e 真实浏览器验证
└── docs/                 架构说明 / 发布指南 / 用户指南
```

## 许可

待定
