const $ = (s) => document.querySelector(s);
const api = (msg) => chrome.runtime.sendMessage(msg);

let serviceOk = false;
let parsed = null;
let prefs = { ...YTDL_DEFAULT_PREFS };
let lastJobsKey = '';

function setMsg(el, text, cls = '') {
  el.textContent = text;
  el.className = 'msg' + (cls ? ' ' + cls : '');
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function initPresets() {
  const sel = $('#preset');
  for (const p of YTDL_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    prefs.preset = sel.value;
    updatePresetDesc();
    chrome.storage.local.set({ ytdlPrefs: prefs });
  });
}

function updatePresetDesc() {
  const item = YTDL_PRESETS.find((p) => p.id === $('#preset').value);
  $('#presetDesc').textContent = item ? item.desc : '';
}

function syncPrefsUi() {
  $('#preset').value = prefs.preset;
  $('#useCookies').checked = Boolean(prefs.useCookies);
  $('#subtitles').checked = Boolean(prefs.subtitles);
  updatePresetDesc();
}

$('#useCookies').addEventListener('change', () => {
  prefs.useCookies = $('#useCookies').checked;
  chrome.storage.local.set({ ytdlPrefs: prefs });
});

$('#subtitles').addEventListener('change', () => {
  prefs.subtitles = $('#subtitles').checked;
  chrome.storage.local.set({ ytdlPrefs: prefs });
});

$('#playlist').addEventListener('change', () => {
  const pl = $('#playlist').checked;
  $('#startTime').disabled = pl;
  $('#endTime').disabled = pl;
  $('#go').textContent = pl ? '批量下载整个播放列表' : '开始下载';
});

function statusText(j) {
  if (j.status === 'queued') return '排队中…';
  if (j.status === 'retrying') return `网络抖动，重试 ${j.attempt}/3…`;
  if (j.status === 'running') {
    const parts = [`${j.percent}%`];
    if (j.speed) parts.push(j.speed);
    if (j.size) parts.push(j.size);
    if (j.eta) parts.push(`剩余 ${j.eta}`);
    return parts.join(' · ');
  }
  if (j.status === 'done') return '已完成';
  if (j.status === 'cancelled') return '已取消';
  return '下载失败';
}

function renderJobs(jobs) {
  const key = JSON.stringify(jobs);
  if (key === lastJobsKey) return;
  lastJobsKey = key;

  const list = $('#jobsList');
  list.textContent = '';

  const activeN = jobs.filter((j) => j.status === 'running' || j.status === 'queued' || j.status === 'retrying').length;
  $('#jobCount').textContent = jobs.length ? `(${activeN || jobs.length})` : '';
  $('#jobsSummary').textContent = activeN ? `进行中 ${activeN} / 总计 ${jobs.length}` : `共 ${jobs.length} 条记录`;

  if (!jobs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '暂无下载任务';
    list.appendChild(empty);
    return;
  }

  for (const j of jobs) {
    const card = document.createElement('div');
    card.className = 'job';

    const top = document.createElement('div');
    top.className = 'job-top';
    const title = document.createElement('div');
    title.className = 'job-title';
    title.textContent = j.title || j.videoId || j.url;
    const tag = document.createElement('span');
    tag.className = 'tag hi';
    tag.textContent = presetLabelOf(j.preset);
    top.append(title, tag);
    card.appendChild(top);

    const meta = document.createElement('div');
    meta.className = 'job-meta';
    meta.textContent = statusText(j);
    if (j.startTime || j.endTime) {
      const clip = document.createElement('span');
      clip.className = 'tag';
      clip.textContent = `片段 ${j.startTime || '00:00'}-${j.endTime || '末'}`;
      meta.appendChild(clip);
    }
    if (j.subtitles) {
      const sub = document.createElement('span');
      sub.className = 'tag';
      sub.textContent = '字幕';
      meta.appendChild(sub);
    }
    card.appendChild(meta);

    if (j.status === 'running' || j.status === 'retrying' || j.status === 'done') {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = `${j.status === 'done' ? 100 : j.percent}%`;
      if (j.status === 'done') fill.className = 'done';
      bar.appendChild(fill);
      card.appendChild(bar);
    }

    if (j.error) {
      const err = document.createElement('div');
      err.className = 'job-err';
      err.textContent = j.error;
      card.appendChild(err);
    }

    const actions = document.createElement('div');
    actions.className = 'job-actions';
    if (j.status === 'running' || j.status === 'queued' || j.status === 'retrying') {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ghost';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', async () => {
        cancelBtn.disabled = true;
        await api({ type: 'cancel', id: j.id });
        refreshJobs();
      });
      actions.appendChild(cancelBtn);
    } else if (j.status === 'done') {
      const openBtn = document.createElement('button');
      openBtn.className = 'ghost';
      openBtn.textContent = '打开文件位置';
      openBtn.addEventListener('click', () => api({ type: 'open', id: j.id }));
      actions.appendChild(openBtn);
    } else if (j.status === 'error' || j.status === 'cancelled') {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'ghost';
      retryBtn.textContent = '重试';
      retryBtn.addEventListener('click', async () => {
        retryBtn.disabled = true;
        await api({ type: 'retry', id: j.id, useCookies: prefs.useCookies });
        refreshJobs();
      });
      actions.appendChild(retryBtn);
    }
    if (actions.childNodes.length) card.appendChild(actions);

    list.appendChild(card);
  }
}

async function refreshJobs() {
  if (!serviceOk) return;
  const jobs = await api({ type: 'jobs' });
  if (Array.isArray(jobs)) renderJobs(jobs);
}

$('#openDir').addEventListener('click', () => api({ type: 'open', dir: true }));

$('#clearJobs').addEventListener('click', async () => {
  await api({ type: 'clearJobs' });
  refreshJobs();
});

$('#go').addEventListener('click', async () => {
  if (!parsed || !serviceOk) return;
  const isPl = parsed.isPlaylistOnly || $('#playlist').checked;
  $('#go').disabled = true;
  setMsg($('#dlMsg'), isPl ? '正在解析播放列表…' : '正在提交任务…');

  const res = await api({
    type: 'download',
    url: parsed.url,
    preset: prefs.preset,
    subtitles: prefs.subtitles,
    useCookies: prefs.useCookies,
    playlist: isPl,
    startTime: isPl ? '' : $('#startTime').value.trim(),
    endTime: isPl ? '' : $('#endTime').value.trim(),
  });

  $('#go').disabled = false;
  if (res?.error) {
    setMsg($('#dlMsg'), res.error, 'err');
    return;
  }

  if (res.count) {
    setMsg($('#dlMsg'), `已入队 ${res.count} 个视频（${res.playlistTitle || '播放列表'}）`, 'ok');
  } else {
    setMsg($('#dlMsg'), '已加入下载队列', 'ok');
  }
  await refreshJobs();
  switchTab('jobs');
});

$('#saveCfg').addEventListener('click', async () => {
  $('#saveCfg').disabled = true;
  setMsg($('#cfgMsg'), '正在保存…');
  const res = await api({
    type: 'setConfig',
    config: {
      outDir: $('#cfgOutDir').value.trim(),
      proxy: $('#cfgProxy').value.trim(),
      maxConcurrent: Number($('#cfgConcurrent').value),
    },
  });
  $('#saveCfg').disabled = false;
  if (res?.error) {
    setMsg($('#cfgMsg'), res.error, 'err');
    return;
  }
  setMsg($('#cfgMsg'), '已保存并立即生效', 'ok');
});

async function boot() {
  initPresets();
  const saved = await chrome.storage.local.get('ytdlPrefs');
  prefs = { ...YTDL_DEFAULT_PREFS, ...(saved.ytdlPrefs || {}) };
  syncPrefsUi();

  const [health, [tab]] = await Promise.all([
    api({ type: 'health' }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);

  serviceOk = Boolean(health?.ok);
  $('#dot').className = 'dot ' + (serviceOk ? 'ok' : 'bad');
  $('#svc').textContent = serviceOk
    ? `在线 · yt-dlp ${health.ytdlp}${health.ffmpeg ? '' : ' · 缺 ffmpeg'}`
    : health?.error || '本地服务离线';
  $('#openDir').disabled = !serviceOk;

  if (serviceOk && health.config) {
    $('#cfgOutDir').value = health.config.outDir || '';
    $('#cfgProxy').value = health.config.proxy || '';
    $('#cfgConcurrent').value = health.config.maxConcurrent || 2;
  }

  parsed = parseYouTubeUrl(tab?.url || '');
  const infoEl = $('#pageInfo');
  if (!parsed) {
    infoEl.textContent = '当前标签页不是 YouTube 视频或播放列表';
  } else {
    const cleanTitle = (tab?.title || '').replace(/\s*-\s*YouTube\s*$/, '').trim();
    infoEl.textContent = '';
    const badge = document.createElement('span');
    badge.className = 'tag hi';
    badge.textContent = parsed.isPlaylistOnly ? '播放列表' : parsed.isShorts ? 'Shorts' : '视频';
    infoEl.append(badge, document.createTextNode(cleanTitle || parsed.videoId || parsed.listId));

    if (parsed.listId && !parsed.isPlaylistOnly) {
      $('#playlistWrap').style.display = '';
    }
    if (parsed.isPlaylistOnly) {
      $('#startTime').disabled = true;
      $('#endTime').disabled = true;
      $('#go').textContent = '批量下载整个播放列表';
    }
  }

  $('#go').disabled = !(serviceOk && parsed);

  if (serviceOk) {
    await refreshJobs();
    setInterval(refreshJobs, 1000);
  }
}

boot().catch(() => {
  $('#dot').className = 'dot bad';
  $('#svc').textContent = '扩展初始化失败';
});
