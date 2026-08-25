// 歌词拒绝检测（looksLikeRefusal）单元验证：直接 import 真实模块。
import { looksLikeRefusal } from '../src/offscreen/tr-llm.js';

const cases = [
  ['抱歉，我无法提供歌词内容。', true],
  ['由于版权原因，我无法翻译这段歌词。', true],
  ['我不能复述受版权保护的内容。', true],
  ['I can\'t reproduce the lyrics.', true],
  ['这个游戏真的太难了，完全打不过去', false],
  ['没办法，只能再试一次了，加油', false],
  ['她唱得真好听啊', false],
  ['', false],
  [null, false],
];
let fail = 0;
for (const [input, want] of cases) {
  const got = looksLikeRefusal(input);
  const ok = got === want;
  if (!ok) fail++;
  console.log(ok ? 'PASS' : 'FAIL', JSON.stringify(input), '→', got);
}
if (fail) process.exit(1);
console.log('=== 歌词拒绝检测测试完成 ===');
