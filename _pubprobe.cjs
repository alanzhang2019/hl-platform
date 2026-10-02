// 一次性探针：发布受阻时确认线上到底跑的是哪个版本、服务是否还活着。
// 判据说明：本服务错误响应一定带 error 字段；没有 error 的响应才视为有效业务响应。
const BASES = [
  'https://7cc9ddf883bc4c1d8550913d8f91b41d.app.workbuddy.host',
  'https://248e5169e7e744618a2cdd53af50c4e1.sg.agentos-app.run',
];

(async () => {
  for (const base of BASES) {
    const url = base + '/api/health';
    try {
      const r = await fetch(url, { headers: { 'cache-control': 'no-store' } });
      const text = await r.text();
      let j = null;
      try { j = JSON.parse(text); } catch (e) {}
      console.log('=== ' + base);
      console.log('  HTTP ' + r.status);
      if (j) {
        console.log('  version   = ' + j.version);
        console.log('  mockLLM   = ' + j.mockLLM);
        console.log('  ok        = ' + j.ok);
        console.log('  error     = ' + (j.error === undefined ? '(无)' : JSON.stringify(j.error)));
      } else {
        console.log('  非 JSON，前 200 字：');
        console.log('  ' + text.slice(0, 200).replace(/\n/g, ' '));
      }
    } catch (e) {
      console.log('=== ' + base);
      console.log('  ERR ' + e.message);
    }
  }
})();
