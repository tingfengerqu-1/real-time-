// DeepL 翻译：官方 API，日中质量高，需用户自己的 Key（free 版以 :fx 结尾）。

export async function translateDeepL(cfg, text, tl) {
  const key = String(cfg.deeplKey || '').trim();
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(host + '/v2/translate', {
      method: 'POST',
      headers: { Authorization: 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: [text], target_lang: String(tl).startsWith('zh') ? 'ZH' : String(tl).toUpperCase() }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('DeepL HTTP ' + res.status);
    const data = await res.json();
    return (data && data.translations && data.translations[0] && data.translations[0].text) || null;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}
