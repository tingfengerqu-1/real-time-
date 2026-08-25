# 发布指南（Chrome Web Store）

## 打包

```bash
npm install        # 首次：安装 terser
npm run get-libs   # 首次：下载推理运行库三件套
npm run dist       # 压缩混淆 → dist/ + release/real-time-<版本>.zip
```

- `dist/` 可直接"加载已解压的扩展程序"自测；通过后把 `release/` 下的 zip 上传商店。
- 代码保护：自有 JS 经 terser 压缩 + 顶层符号混淆（函数名不可读），保留 warn/error 日志；
  关键字符串字面量（消息类型、接口地址）不参与混淆，引用链/语法在打包时自动校验。
- `dist/` 默认不含 `src/models/`（本地模型权重）；离线分发时自行复制 `src/models/` 进 `dist/` 再重打包。
- 打包会先自动生成版本化引擎产物（同 `npm run version`），无需单独执行。

## 发布前检查清单

- `npm test` 全绿
- `dist/` 加载后跑一场真实直播：本地/云端/混合三种引擎、Google/大模型两档翻译、SRT 导出
- 版本号已在 `package.json` 与 `src/manifest.json` 同步递增

## 商店提交所需权限理由（审核备注模板）

- `tabCapture`：捕获当前 YouTube 标签页音频用于本地语音识别（不收集、不上传音频；
  云端识别模式下音频仅发给用户自己配置的 API 地址）。
- `offscreen`：MV3 要求，音频捕获与本地推理在 offscreen document 进行。
- `storage` / `unlimitedStorage`：保存用户设置与字幕历史；本地模型权重较大（数百 MB），
  unlimitedStorage 防止浏览器配额清理导致反复下载。
- `activeTab` + `scripting`：用户点击扩展图标/快捷键时向当前标签页注入字幕 UI。
- `host_permissions: https://*/*`：翻译服务地址完全由用户配置（智谱/DeepL/OpenAI 兼容端点、
  Google 免费翻译、HuggingFace 模型下载），无法预知域名，故需通配；扩展自身无任何后端服务器。
- CSP `wasm-unsafe-eval`：onnxruntime-web 的 WASM 推理内核要求，仅此用途。

## 隐私声明要点（填写商店隐私表单用）

- 不收集任何用户数据；无统计、无埋点、无第三方分析。
- 识别文本与翻译仅发送到用户自行配置的 API（默认不发送到任何地方——本地识别 + Google
  免费翻译也只发识别出的文字）。API Key 仅保存在本地 chrome.storage，不上传。
- 处理的音频：本地 Whisper 模式不离开设备；云端识别模式仅发往用户配置的识别端点。

## 还需人工准备的素材

- 商店截图 5 张（1280×800 或 640×400）：建议直播页 + 面板、CC 字幕条、设置弹窗、
  歌词翻译、SRT 导出各一张（用真实直播画面截取，注意个人信息）。
- 商店描述文案（可基于 README 首节改写）、小宣传图 440×280（可选）。
- 一次性 5 美元开发者注册费（Chrome Web Store Dashboard）。
