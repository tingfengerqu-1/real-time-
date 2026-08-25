// 识别文本清洗单测：直接 import 真实模块 asr-clean.js，
// 验证清洗/幻觉过滤/副歌重复放行。每个用例新建 cleaner（等价于每次会话重建）。
import { createAsrCleaner } from '../src/offscreen/asr-clean.js';

const results = [];
const t = (name, ok, detail) => { results.push([name, ok, detail]); if (!ok) process.exitCode = 1; };
const run = (cleaner, text) => cleaner.clean({ text });
const fresh = () => createAsrCleaner();

// 1. 正常文本通过
{
  const c = fresh();
  t('正常文本通过', run(c, 'こんにちは今日もゲームやるよ') === 'こんにちは今日もゲームやるよ');
}

// 2. 断句杂符清洗（|| 与下划线）
{
  const c = fresh();
  t('杂符清洗', run(c, 'あ|_い|う  |  え') === 'あ い う え');
}

// 3. 纯音乐/掌声噪声拦截
{
  const c = fresh();
  t('纯噪声拦截', run(c, '（拍手）') === '' && run(c, '♪♪♪') === '' && run(c, 'BGM') === '');
}

// 4. 幻觉黑名单拦截（感谢观看/求订阅）
{
  const c = fresh();
  t('幻觉黑名单', run(c, '最後までご視聴ありがとうございました') === '' && run(c, 'チャンネル登録お願いします') === '');
}

// 5. 短句重复（≤12字）在最近 4 条内 → 拦截（幻觉循环防护）
{
  const c = fresh();
  run(c, 'うん'); run(c, 'そうだね'); run(c, 'えっと');
  t('短句重复拦截', run(c, 'うん') === '');
}

// 6. 副歌长句（≥13字）隔几行逐字重现 → 放行（长句只拦紧邻重复）
{
  const c = fresh();
  const chorus = '君を想えば遠い空を見上げてしまう夜だ';
  run(c, chorus); run(c, 'うん、次の曲いきます'); run(c, 'えっと、チューニング待ってて');
  t('副歌长句隔行重现放行', run(c, chorus) === chorus);
}

// 7. 长句紧邻逐字重复 → 仍拦截（连续同一长句是幻觉的典型形态）
{
  const c = fresh();
  const chorus = '君を想えば遠い空を見上げてしまう夜だ';
  run(c, chorus);
  t('长句紧邻重复拦截', run(c, chorus) === '');
}

// 8. 短句隔 4 条以上重现 → 放行（去重窗口语义不变）
{
  const c = fresh();
  run(c, 'うん'); run(c, 'あ'); run(c, 'い'); run(c, 'う'); run(c, 'え');
  t('短句隔4条重现放行', run(c, 'うん') === 'うん');
}

for (const [n, ok, d] of results) console.log(ok ? 'PASS' : 'FAIL', n, ok ? '' : '→ ' + (d || ''));
console.log('=== ASR 清洗/副歌去重测试完成 ===');
