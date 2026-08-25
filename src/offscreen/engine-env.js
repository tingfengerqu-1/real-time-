// 引擎环境：transformers.js 的唯一引入入口 + 引擎版本号。
// 所有需要 pipeline/env 的模块一律从这里 import，
// 打包时（tools/make-versioned.cjs）才能把唯一的 transformers 引入保留在产物顶部并替换为版本化文件名。

import * as Transformers from '../libs/transformers.min.js?v=5';

export const pipeline = Transformers.pipeline;
export const env = Transformers.env;

// 版本标记：面板状态会带上它，用于确认浏览器运行的是最新代码（排除模块缓存）
export const ENGINE_VERSION = 'v1';
