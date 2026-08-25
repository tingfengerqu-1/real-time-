// 消息总线：引擎各模块共用的状态上报通道。
// bannerStatus 记录当前"运行中"横幅文案，临时警告（8 秒后恢复）都从这里取回。

let bannerStatus = '';

export function getBannerStatus() {
  return bannerStatus;
}

export function post(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* service worker 唤醒中 */ });
}

export function postStatus(status, error) {
  post({ type: 'offscreen-status', status: status || '', error: error || '' });
}

// 运行横幅：除展示外记住内容，供临时警告结束后恢复
export function postBanner(status) {
  bannerStatus = status;
  postStatus(status);
}
