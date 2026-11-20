// 统一代理 localhost 请求（content script 受 CORS 限制），并按需导出 YouTube 登录态 Cookie。
const BASE = 'http://127.0.0.1:8877';

async function call(path, init) {
  const res = await fetch(BASE + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const post = (path, body) =>
  call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

async function exportYouTubeCookies() {
  try {
    const list = await chrome.cookies.getAll({ domain: 'youtube.com' });
    if (!list.length) return '';
    const lines = ['# Netscape HTTP Cookie File'];
    for (const c of list) {
      const domain = c.domain || '.youtube.com';
      const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const path = c.path || '/';
      const secure = c.secure ? 'TRUE' : 'FALSE';
      const exp = c.expirationDate ? String(Math.floor(c.expirationDate)) : '0';
      lines.push(`${domain}\t${flag}\t${path}\t${secure}\t${exp}\t${c.name}\t${c.value}`);
    }
    return lines.join('\n') + '\n';
  } catch {
    return '';
  }
}

function updateBadge(jobs) {
  if (!Array.isArray(jobs)) return;
  const activeCount = jobs.filter(
    (j) => j.status === 'running' || j.status === 'queued' || j.status === 'retrying',
  ).length;
  chrome.action.setBadgeText({ text: activeCount > 0 ? String(activeCount) : '' });
  if (activeCount > 0) chrome.action.setBadgeBackgroundColor({ color: '#2f6fed' });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.type === 'health') return reply(await call('/health'));
      if (msg.type === 'jobs') {
        const list = await call('/jobs');
        updateBadge(list);
        return reply(list);
      }
      if (msg.type === 'download') {
        const payload = {
          url: msg.url,
          preset: msg.preset || 'ios',
          subtitles: Boolean(msg.subtitles),
          startTime: msg.startTime || '',
          endTime: msg.endTime || '',
          playlist: Boolean(msg.playlist),
        };
        if (msg.useCookies) payload.cookies = await exportYouTubeCookies();
        const res = await post('/download', payload);
        call('/jobs').then(updateBadge).catch(() => {});
        return reply(res);
      }
      if (msg.type === 'cancel') {
        const res = await post(`/jobs/${encodeURIComponent(msg.id)}/cancel`);
        call('/jobs').then(updateBadge).catch(() => {});
        return reply(res);
      }
      if (msg.type === 'retry') {
        const payload = {};
        if (msg.useCookies) payload.cookies = await exportYouTubeCookies();
        const res = await post(`/jobs/${encodeURIComponent(msg.id)}/retry`, payload);
        call('/jobs').then(updateBadge).catch(() => {});
        return reply(res);
      }
      if (msg.type === 'clearJobs') {
        const res = await post('/jobs/clear');
        call('/jobs').then(updateBadge).catch(() => {});
        return reply(res);
      }
      if (msg.type === 'open') {
        return reply(await post('/open', msg.dir ? { dir: true } : { id: msg.id }));
      }
      if (msg.type === 'getConfig') return reply(await call('/config'));
      if (msg.type === 'setConfig') return reply(await post('/config', msg.config));

      reply({ error: `未知消息 ${msg.type}` });
    } catch (e) {
      reply({
        error:
          e.message === 'Failed to fetch'
            ? '本地服务未启动（请运行 server/install-autostart.cmd 或 start-silent.vbs）'
            : e.message,
      });
    }
  })();
  return true;
});
