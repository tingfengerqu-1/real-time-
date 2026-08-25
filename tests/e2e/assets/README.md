# e2e 音频样本（不入库）

端到端测试需要真实的日语语音片段（每段 5-15 秒，`.ogg`/`.wav` 均可）：

- `ja2.ogg`
- `ja4.ogg`
- `ja5.ogg`

可自行录制或截取无版权争议的语音，放在本目录后即可运行：

```
node tests/e2e/server.cjs    # 终端 1
node tests/e2e/run-e2e.cjs   # 终端 2（Chrome Dev/Beta，或设 CHROME_PATH）
```

文件名可在 `test-audio.html` 的 `clips` 数组里修改。
