// 在 YouTube 普通播放页和 Shorts 页面注入下载按钮，带格式下拉、进度跟踪、切视频自动重置和完成后打开文件位置。
const WRAP_ID = 'ytdl-ext-wrap';
const MENU_ID = 'ytdl-ext-menu';
const SHORTS_BTN_ID = 'ytdl-ext-shorts-btn';

let prefs = { ...YTDL_DEFAULT_PREFS };
let currentVideoId = null;
let activeJobId = null;
let pollTimer = null;

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => null);
}

async function loadPrefs() {
  try {
    const saved = await chrome.storage.local.get('ytdlPrefs');
    prefs = { ...YTDL_DEFAULT_PREFS, ...(saved.ytdlPrefs || {}) };
  } catch {}
}

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.ytdlPrefs?.newValue) {
    prefs = { ...YTDL_DEFAULT_PREFS, ...changes.ytdlPrefs.newValue };
    syncIdleLabel();
  }
});

function closeMenu() {
  document.getElementById(MENU_ID)?.remove();
}

function setBtnState(text, { disabled = false, title = '', doneJobId = null } = {}) {
  activeJobId = doneJobId;
  const main = document.querySelector(`#${WRAP_ID} .ytdl-main`);
  if (main) {
    main.textContent = text;
    main.disabled = disabled;
    if (title) main.title = title;
  }
  const sBtn = document.getElementById(SHORTS_BTN_ID);
  if (sBtn) {
    sBtn.textContent = text;
    sBtn.disabled = disabled;
    if (title) sBtn.title = title;
  }
}

function syncIdleLabel() {
  if (pollTimer || activeJobId) return;
  const short = presetLabelOf(prefs.preset);
  setBtnState('下载', {
    disabled: false,
    title: `用本地 yt-dlp 下载（当前预设：${short}）`,
  });
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function applyJobToButton(job) {
  if (!job) {
    stopPoll();
    activeJobId = null;
    syncIdleLabel();
    return;
  }
  if (job.status === 'queued') {
    setBtnState('排队中', { disabled: true, title: '任务已入队，等待空闲通道' });
    return;
  }
  if (job.status === 'retrying') {
    setBtnState(`重试 ${job.attempt}/3`, { disabled: true, title: '网络抖动，正在自动重试' });
    return;
  }
  if (job.status === 'running') {
    const lbl = job.speed ? `${job.percent}% · ${job.speed}` : `${job.percent}%`;
    setBtnState(lbl, { disabled: true, title: `下载中 ${lbl}` });
    return;
  }
  stopPoll();
  if (job.status === 'done') {
    setBtnState('已保存', {
      disabled: false,
      title: '点击在资源管理器中定位文件',
      doneJobId: job.id,
    });
    return;
  }
  if (job.status === 'error') {
    setBtnState('失败', { disabled: false, title: job.error || '下载失败，点击重试' });
    return;
  }
  syncIdleLabel();
}

async function syncCurrentVideoStatus() {
  const info = parseYouTubeUrl(location.href);
  if (!info?.videoId) {
    stopPoll();
    return;
  }
  const jobs = await send({ type: 'jobs' });
  if (!Array.isArray(jobs)) return;
  // 再次确认用户没有在异步请求期间切到别的视频
  const latest = parseYouTubeUrl(location.href);
  if (latest?.videoId !== info.videoId) return;

  const job = jobs.find((j) => j.videoId === info.videoId || j.url.includes(info.videoId));
  applyJobToButton(job);
  if (job && (job.status === 'running' || job.status === 'queued' || job.status === 'retrying')) {
    startPoll(info.videoId);
  }
}

function startPoll(videoId) {
  stopPoll();
  pollTimer = setInterval(async () => {
    const now = parseYouTubeUrl(location.href);
    if (now?.videoId !== videoId) {
      stopPoll();
      return;
    }
    const jobs = await send({ type: 'jobs' });
    if (!Array.isArray(jobs)) return;
    const job = jobs.find((j) => j.videoId === videoId || j.url.includes(videoId));
    applyJobToButton(job);
  }, 1200);
}

async function triggerDownload(presetOverride) {
  closeMenu();
  const info = parseYouTubeUrl(location.href);
  if (!info?.videoId) return;

  if (!presetOverride && activeJobId) {
    await send({ type: 'open', id: activeJobId });
    return;
  }

  const preset = presetOverride || prefs.preset;
  if (presetOverride && presetOverride !== prefs.preset) {
    prefs.preset = presetOverride;
    chrome.storage?.local?.set({ ytdlPrefs: prefs });
  }

  activeJobId = null;
  setBtnState('提交中…', { disabled: true });
  const res = await send({
    type: 'download',
    url: `https://www.youtube.com/watch?v=${info.videoId}`,
    preset,
    subtitles: prefs.subtitles,
    useCookies: prefs.useCookies,
  });

  if (!res || res.error) {
    setBtnState('失败', { disabled: false, title: res?.error || '无法连接本地服务' });
    return;
  }
  setBtnState('排队中', { disabled: true });
  startPoll(info.videoId);
}

function openPresetMenu(anchor) {
  if (document.getElementById(MENU_ID)) {
    closeMenu();
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.id = MENU_ID;
  Object.assign(menu.style, {
    position: 'fixed',
    top: `${rect.bottom + 6}px`,
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 210))}px`,
    zIndex: '2147483647',
    minWidth: '196px',
    background: '#212126',
    color: '#f1f1f1',
    border: '1px solid rgba(255,255,255,.14)',
    borderRadius: '10px',
    padding: '5px',
    boxShadow: '0 8px 24px rgba(0,0,0,.45)',
    font: '13px/1.4 system-ui, "Segoe UI", sans-serif',
  });

  for (const p of YTDL_PRESETS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = (p.id === prefs.preset ? '✓ ' : '　 ') + p.label;
    Object.assign(item.style, {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      padding: '7px 10px',
      border: '0',
      borderRadius: '6px',
      background: p.id === prefs.preset ? 'rgba(47,111,237,.22)' : 'transparent',
      color: '#f1f1f1',
      cursor: 'pointer',
      font: 'inherit',
    });
    item.addEventListener('mouseenter', () => (item.style.background = 'rgba(255,255,255,.1)'));
    item.addEventListener('mouseleave', () =>
      (item.style.background = p.id === prefs.preset ? 'rgba(47,111,237,.22)' : 'transparent'),
    );
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerDownload(p.id);
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById(MENU_ID);
  if (menu && !menu.contains(e.target) && !e.target.closest?.(`#${WRAP_ID}`)) closeMenu();
});

function buildWatchButton() {
  const wrap = document.createElement('div');
  wrap.id = WRAP_ID;
  Object.assign(wrap.style, {
    display: 'inline-flex',
    alignItems: 'center',
    marginLeft: '8px',
    height: '36px',
    borderRadius: '18px',
    overflow: 'hidden',
    background: 'rgba(255,255,255,.1)',
    verticalAlign: 'middle',
  });

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'ytdl-main';
  main.textContent = '下载';
  Object.assign(main.style, {
    height: '36px',
    padding: '0 10px 0 14px',
    border: '0',
    background: 'transparent',
    color: 'var(--yt-spec-text-primary, #f1f1f1)',
    font: '500 14px/36px "YouTube Sans", Roboto, sans-serif',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });
  main.addEventListener('click', () => triggerDownload());

  const arrow = document.createElement('button');
  arrow.type = 'button';
  arrow.textContent = '▾';
  arrow.title = '选择画质/格式并下载';
  Object.assign(arrow.style, {
    height: '36px',
    padding: '0 10px 0 6px',
    border: '0',
    borderLeft: '1px solid rgba(255,255,255,.14)',
    background: 'transparent',
    color: 'var(--yt-spec-text-primary, #f1f1f1)',
    font: '13px/36px sans-serif',
    cursor: 'pointer',
  });
  arrow.addEventListener('click', (e) => {
    e.stopPropagation();
    openPresetMenu(wrap);
  });

  wrap.append(main, arrow);
  return wrap;
}

function buildShortsButton() {
  const btn = document.createElement('button');
  btn.id = SHORTS_BTN_ID;
  btn.type = 'button';
  btn.textContent = '下载';
  Object.assign(btn.style, {
    marginTop: '12px',
    width: '48px',
    minHeight: '48px',
    padding: '4px 2px',
    borderRadius: '24px',
    border: '0',
    background: 'rgba(255,255,255,.14)',
    color: 'var(--yt-spec-text-primary, #f1f1f1)',
    font: '600 11px/1.2 system-ui, sans-serif',
    cursor: 'pointer',
    wordBreak: 'break-all',
  });
  btn.addEventListener('click', () => triggerDownload());
  return btn;
}

function ensureMounted() {
  const info = parseYouTubeUrl(location.href);
  if (!info?.videoId) return;

  const changed = info.videoId !== currentVideoId;
  if (changed) {
    currentVideoId = info.videoId;
    activeJobId = null;
    stopPoll();
    closeMenu();
  }

  if (info.isShorts) {
    const actions =
      document.querySelector('ytd-reel-video-renderer[is-active] #actions') ||
      document.querySelector('ytd-reel-video-renderer #actions');
    if (actions && !actions.querySelector(`#${SHORTS_BTN_ID}`)) {
      document.getElementById(SHORTS_BTN_ID)?.remove();
      actions.appendChild(buildShortsButton());
      syncCurrentVideoStatus();
    } else if (changed) {
      syncCurrentVideoStatus();
    }
  } else {
    const host = document.querySelector('#top-level-buttons-computed');
    if (host && !document.getElementById(WRAP_ID)) {
      host.appendChild(buildWatchButton());
      syncCurrentVideoStatus();
    } else if (changed) {
      syncCurrentVideoStatus();
    }
  }
}

loadPrefs().then(() => {
  ensureMounted();
  window.addEventListener('yt-navigate-finish', () => setTimeout(ensureMounted, 200));
  setInterval(ensureMounted, 1500);
});
