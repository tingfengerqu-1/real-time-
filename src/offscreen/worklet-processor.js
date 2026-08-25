// 音频切分处理器：以 16kHz 单声道运行。
// - 固定低阈值语音判定：跳过纯静音片段，从源头杜绝 Whisper 对静音的幻觉
// - 停顿（>= 0.35s 静音）或达到最大段长时切分，交给主线程识别；
//   切分时带上 pauseEnded 标记，主线程据此对"停顿结束的长句"立即上屏（免拼装等待）
// - 每段保留末尾 150ms 作为下一段开头，减少词被切在边界造成的识别错误
// - 输入直通输出，保证捕获期间标签页声音正常回放

class ChunkRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = [];
    this.length = 0;        // 已积累采样数
    this.hasSpeech = false; // 当前段内是否出现过语音
    this.silentBlocks = 0;  // 连续低能量块计数（每块 128 采样）
    this.noiseFloor = 0.004; // 自适应噪声底

    // 最长段时长由外部传入（完整优先 13s：上下文多、断句准 / 实时优先 4.5s：延迟低）
    const maxSec = (options && options.processorOptions && options.processorOptions.maxSec) || 13;
    this.MIN_LEN = Math.floor(16000 * 0.7);                // 最短段 0.7s（短感叹也能独立成句）
    this.MAX_LEN = Math.floor(16000 * maxSec);
    this.SILENT_BLOCKS = Math.floor((0.35 * 16000) / 128); // 停顿判定（换气通常 <0.3s，0.35 基本不误切）
  }

  process(inputs, outputs) {
    // 防御：process 内任何异常都会永久杀死 worklet 节点（表现为只出第一句后永久静默），必须兜底
    try {
      this.processInner(inputs, outputs);
    } catch (e) {
      // 重置状态尽量继续工作，绝不让节点死亡
      try { this.reset(); } catch (e2) { /* 忽略 */ }
    }
    return true;
  }

  processInner(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    if (input && input.length) {
      // 直通输出：保证捕获期间标签页声音正常播放
      const output = outputs[0] && outputs[0][0];
      if (output && output.length === input.length) output.set(input);

      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);

      // 语音判定：固定低阈值——只要"有声音"（说话或音乐）就算语音段；
      // 真静音（暂停视频/无人说话的数字底噪）不算，从源头杜绝 Whisper 对静音的幻觉
      const isSpeech = rms >= 0.0035;
      if (!isSpeech) {
        this.noiseFloor = this.noiseFloor * 0.997 + rms * 0.003;
      }

      this.buffer.push(new Float32Array(input));
      this.length += input.length;

      if (isSpeech) {
        this.silentBlocks = 0;
        this.hasSpeech = true;
      } else {
        this.silentBlocks++;
      }

      const pauseDetected = this.silentBlocks >= this.SILENT_BLOCKS;
      // 停顿切分与最大段长切分都要求检测到声音；完全无声的段直接丢弃，
      // 不送给识别（Whisper 对纯静音会幻觉输出"感谢观看"等套话）
      if (this.hasSpeech && ((this.length >= this.MIN_LEN && pauseDetected) || this.length >= this.MAX_LEN)) {
        this.flush(pauseDetected);
      } else if (!this.hasSpeech && this.length >= this.MAX_LEN) {
        this.reset();
      }
    }
  }

  flush(pauseEnded) {
    const merged = new Float32Array(this.length);
    let offset = 0;
    for (const block of this.buffer) {
      merged.set(block, offset);
      offset += block.length;
    }
    // 关键：先取末尾快照再转移所有权——postMessage 转移后 merged 的 buffer 会被分离，
    // 之后再 slice 会抛异常并杀死 worklet（正是"只有第一句"的根因）
    const keep = merged.slice(Math.max(0, merged.length - 2400));
    this.port.postMessage({ samples: merged, pauseEnded: !!pauseEnded }, [merged.buffer]);
    // 保留末尾 150ms 作为下一段的开头，减少边界切词
    this.buffer = [keep];
    this.length = keep.length;
    this.hasSpeech = false;
    this.silentBlocks = 0;
  }

  reset() {
    this.buffer = [];
    this.length = 0;
    this.hasSpeech = false;
    this.silentBlocks = 0;
  }
}

registerProcessor('chunk-recorder', ChunkRecorder);
