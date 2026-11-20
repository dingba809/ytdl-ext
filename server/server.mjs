// 本地下载服务：Chrome 扩展把 YouTube 链接 POST 过来，这里调 yt-dlp 落盘。
// 支持多任务并发队列、格式预设、字幕、片段截取、播放列表展开、临时 Cookie、打开文件位置。
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.YTDL_PORT || 8877);
const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  outDir: process.env.YTDL_DIR || path.join(os.homedir(), 'Downloads', 'ytdl'),
  proxy: process.env.YTDL_PROXY || '',
  maxConcurrent: 2,
};

// 格式预设：iOS 只能稳播 H.264(avc1) + AAC(mp4a)，代价是画质封顶 1080p；
// 需要 2K/4K 时选 best（VP9/AV1）。
const PRESETS = {
  ios: {
    label: 'iOS 1080p MP4',
    args: [
      '-f',
      'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[vcodec^=avc1]+ba/bv*+ba/b',
      '--merge-output-format',
      'mp4',
    ],
  },
  best: {
    label: '原画最高 (2K/4K)',
    args: ['-f', 'bv*+ba[acodec^=mp4a]/bv*+ba/b', '--merge-output-format', 'mp4'],
  },
  '720p': {
    label: '720p 省流 MP4',
    args: [
      '-f',
      'bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=720][vcodec^=avc1]+ba/bv*[height<=720]+ba/b',
      '--merge-output-format',
      'mp4',
    ],
  },
  mp3: {
    label: '纯音频 MP3',
    args: ['-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  },
  m4a: {
    label: '纯音频 M4A',
    args: ['-x', '--audio-format', 'm4a', '--audio-quality', '0'],
  },
};

const MAX_ATTEMPTS = 3;
const MAX_PLAYLIST_ITEMS = 50; // shortcut: 单次播放列表最多展开 50 条，防误点超大列表炸队列
const TRANSIENT = /getaddrinfo|Failed to resolve|timed out|Connection reset|Temporary failure|URLopen error|IncompleteRead/i;
const NEEDS_AUTH = /Sign in|age|members|Private video|login|confirm you.?re not a bot|Requested format is not available/i;
const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      outDir: typeof raw.outDir === 'string' && raw.outDir.trim() ? raw.outDir.trim() : DEFAULT_CONFIG.outDir,
      proxy: typeof raw.proxy === 'string' ? raw.proxy.trim() : DEFAULT_CONFIG.proxy,
      maxConcurrent: Math.min(4, Math.max(1, Number(raw.maxConcurrent) || DEFAULT_CONFIG.maxConcurrent)),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(next) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
}

let config = loadConfig();
fs.mkdirSync(config.outDir, { recursive: true });

// Windows 上 pip/winget 安装的入口脚本未必在当前进程 PATH 里，启动时自动定位
function findYtDlp() {
  const pyRoot = path.join(process.env.APPDATA || '', 'Python');
  const cands = [];
  if (fs.existsSync(pyRoot))
    for (const d of fs.readdirSync(pyRoot))
      cands.push(path.join(pyRoot, d, 'Scripts', 'yt-dlp.exe'));
  return cands.find((p) => fs.existsSync(p)) ?? 'yt-dlp';
}

function findFfmpegDir() {
  const pkgRoot = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (!fs.existsSync(pkgRoot)) return null;
  for (const p of fs.readdirSync(pkgRoot).filter((d) => /ffmpeg/i.test(d))) {
    const dir = path.join(pkgRoot, p);
    for (const sub of fs.readdirSync(dir)) {
      const bin = path.join(dir, sub, 'bin');
      if (fs.existsSync(path.join(bin, 'ffmpeg.exe'))) return bin;
    }
  }
  return null;
}

const versionOf = (cmd, args) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', (c) => resolve(c === 0 ? out.trim().split(/\r?\n/)[0] : null));
  });

const ytdlp = findYtDlp();
const ffmpegDir = findFfmpegDir();
const ytdlpVersion = await versionOf(ytdlp, ['--version']);
const spawnEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };

const jobs = new Map();
const jobCookies = new Map(); // 独立存放临时 Cookie，绝不序列化到 /jobs，任务结束立即清理
const active = new Map(); // id -> { child, timer, cookieFile, pathFile }
let seq = 0;

function assertYouTube(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('无效链接');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('仅支持 http/https 链接');
  if (!/(^|\.)(youtube\.com|youtu\.be)$/.test(u.hostname)) throw new Error('只支持 YouTube 链接');
  return u;
}

function validateTime(val, name) {
  if (!val) return '';
  const s = String(val).trim();
  if (!s) return '';
  if (!TIME_RE.test(s)) throw new Error(`${name}格式应为 mm:ss 或 hh:mm:ss`);
  return s;
}

function validateConfigPatch(patch) {
  const next = { ...config };
  if ('outDir' in patch) {
    const dir = String(patch.outDir || '').trim();
    if (!dir || !path.isAbsolute(dir)) throw new Error('保存目录必须是绝对路径');
    fs.mkdirSync(dir, { recursive: true });
    next.outDir = dir;
  }
  if ('proxy' in patch) {
    const p = String(patch.proxy || '').trim();
    if (p) {
      let u;
      try { u = new URL(p); } catch { throw new Error('代理地址格式无效，如 http://127.0.0.1:7890'); }
      if (!/^(http|https|socks5|socks5h):$/.test(u.protocol)) throw new Error('代理仅支持 http/https/socks5');
    }
    next.proxy = p;
  }
  if ('maxConcurrent' in patch) {
    const n = Number(patch.maxConcurrent);
    if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error('同时下载数范围 1~4');
    next.maxConcurrent = n;
  }
  return next;
}

function extractVideoId(u) {
  if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] || '';
  if (u.pathname === '/watch') return u.searchParams.get('v') || '';
  if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || '';
  return '';
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { child.kill('SIGTERM'); } catch {}
  }
}

function cleanupJobRuntime(id, keepCookies = false) {
  const rt = active.get(id);
  if (rt) {
    if (rt.timer) clearTimeout(rt.timer);
    if (rt.cookieFile) fs.rmSync(rt.cookieFile, { force: true });
    if (rt.pathFile) fs.rmSync(rt.pathFile, { force: true });
    active.delete(id);
  }
  if (!keepCookies) jobCookies.delete(id);
}

function pruneJobs() {
  // shortcut: 只留最近 50 条已完成/失败/取消的历史，避免内存无限增长
  for (const [id, job] of jobs) {
    if (jobs.size <= 50) break;
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      jobs.delete(id);
      jobCookies.delete(id);
    }
  }
}

function activeRunningCount() {
  let n = 0;
  for (const job of jobs.values())
    if (job.status === 'running' || job.status === 'retrying') n++;
  return n;
}

function pumpQueue() {
  while (activeRunningCount() < config.maxConcurrent) {
    const next = [...jobs.values()].find((j) => j.status === 'queued');
    if (!next) break;
    runAttempt(next, 1);
  }
}

function enqueueJob(url, opts, cookiesText, initialTitle = '') {
  const u = assertYouTube(url);
  const preset = PRESETS[opts.preset] ? opts.preset : 'ios';
  const startTime = validateTime(opts.startTime, '开始时间');
  const endTime = validateTime(opts.endTime, '结束时间');
  const id = String(++seq);
  const job = {
    id,
    url: u.href,
    videoId: extractVideoId(u),
    preset,
    presetLabel: PRESETS[preset].label,
    subtitles: Boolean(opts.subtitles),
    startTime,
    endTime,
    status: 'queued',
    percent: 0,
    speed: '',
    size: '',
    eta: '',
    attempt: 0,
    title: initialTitle,
    file: '',
    error: '',
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  if (cookiesText) jobCookies.set(id, cookiesText);
  pumpQueue();
  return id;
}

function runAttempt(job, n, useCookieNow = false) {
  if (job.status === 'cancelled') return;
  fs.mkdirSync(config.outDir, { recursive: true });

  job.status = 'running';
  job.attempt = n;
  job.percent = 0;
  job.speed = '';
  job.eta = '';
  job.error = '';

  const pathFile = path.join(os.tmpdir(), `ytdl-${job.id}-${n}.path`);
  let cookieFile = null;
  const cookiesText = jobCookies.get(job.id);
  // 公开视频先匿名下（拿满无登录客户端格式、避开登录态 PO Token 限制），
  // 遇到需登录/年龄限制/会员/防爬时自动切用浏览器 Cookie 重试。
  if (useCookieNow && cookiesText) {
    cookieFile = path.join(os.tmpdir(), `ytdl-ck-${job.id}-${n}.txt`);
    fs.writeFileSync(cookieFile, cookiesText, { encoding: 'utf8', mode: 0o600 });
  }

  const clipSuffix = job.startTime || job.endTime
    ? ` [${(job.startTime || '00-00').replace(/:/g, '-')}_${(job.endTime || 'end').replace(/:/g, '-')}]`
    : '';

  const args = [
    ...PRESETS[job.preset].args,
    '--js-runtimes', `node:${process.execPath}`,
    '--no-playlist',
    '--no-warnings',
    '--no-simulate',
    '--no-quiet',
    '--force-ipv4',
    '--socket-timeout', '15',
    '--retries', '5',
    '--newline',
    '--print', 'before_dl:YTDL_TITLE:%(title)s',
    '--progress-template',
    'download:YTDL_PROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._total_bytes_str,progress._total_bytes_estimate_str)s|%(progress._eta_str)s',
    '-P', config.outDir,
    '-o', `%(title).140B [%(id)s]${clipSuffix}.%(ext)s`,
    '--print-to-file', 'after_move:filepath', pathFile,
  ];

  if (job.subtitles) {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'zh-Hans,zh-Hant,zh,en', '--convert-subs', 'srt');
  }
  if (job.startTime || job.endTime) {
    const range = `*${job.startTime || '00:00'}-${job.endTime || 'inf'}`;
    args.push('--download-sections', range, '--force-keyframes-at-cuts');
  }
  if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir);
  if (config.proxy) args.push('--proxy', config.proxy);
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push('--', job.url);

  const tail = [];
  const child = spawn(ytdlp, args, { windowsHide: true, env: spawnEnv });
  active.set(job.id, { child, timer: null, cookieFile, pathFile });

  const clean = (s) => (s && s !== 'NA' && s !== 'Unknown' ? s.trim() : '');
  const scan = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (line.startsWith('YTDL_TITLE:')) {
        job.title = line.slice('YTDL_TITLE:'.length).trim();
        continue;
      }
      if (line.startsWith('YTDL_PROG|')) {
        const [, pct, spd, sz, eta] = line.split('|');
        const m = pct?.match(/([\d.]+)%/);
        if (m) job.percent = Math.min(100, Math.round(Number(m[1])));
        if (clean(spd)) job.speed = clean(spd);
        if (clean(sz)) job.size = clean(sz);
        if (clean(eta)) job.eta = clean(eta);
        continue;
      }
      tail.push(line);
      if (tail.length > 40) tail.shift();
    }
  };

  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('error', (e) => {
    if (job.status === 'cancelled') return;
    job.status = 'error';
    job.error = e.message;
    cleanupJobRuntime(job.id);
    pumpQueue();
  });

  child.on('close', (code) => {
    if (job.status === 'cancelled') {
      cleanupJobRuntime(job.id);
      pumpQueue();
      return;
    }

    if (code === 0) {
      job.status = 'done';
      job.percent = 100;
      job.speed = '';
      job.eta = '';
      job.file = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8').trim() : '';
      if (job.file && !job.title) job.title = path.basename(job.file).replace(/\.[^.]+$/, '');
      cleanupJobRuntime(job.id);
      pruneJobs();
      pumpQueue();
      return;
    }

    const joined = tail.join('\n');
    // 匿名失败但报错要求登录/年龄限制/防爬时，立即切用 Chrome Cookie 重试一次
    if (!useCookieNow && jobCookies.get(job.id) && NEEDS_AUTH.test(joined)) {
      cleanupJobRuntime(job.id, true);
      runAttempt(job, n, true);
      return;
    }

    if (n < MAX_ATTEMPTS && TRANSIENT.test(joined)) {
      cleanupJobRuntime(job.id, true); // 保留内存 cookie 给下一次重试，重试完即清
      job.status = 'retrying';
      job.speed = '';
      job.eta = '';
      const timer = setTimeout(() => runAttempt(job, n + 1, useCookieNow), n * 3000);
      active.set(job.id, { child: null, timer, cookieFile: null, pathFile: null });
      return;
    }

    job.status = 'error';
    job.speed = '';
    job.eta = '';
    job.error = tail.filter((l) => l.includes('ERROR:')).at(-1)?.trim() || `yt-dlp 退出码 ${code}`;
    cleanupJobRuntime(job.id);
    pruneJobs();
    pumpQueue();
  });
}

function expandPlaylist(url, cookiesText) {
  return new Promise((resolve, reject) => {
    let cookieFile = null;
    if (cookiesText) {
      cookieFile = path.join(os.tmpdir(), `ytdl-pl-${Date.now()}.txt`);
      fs.writeFileSync(cookieFile, cookiesText, { encoding: 'utf8', mode: 0o600 });
    }
    const args = [
      '--js-runtimes', `node:${process.execPath}`,
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings',
      '--force-ipv4',
      '--socket-timeout', '15',
      '--playlist-end', String(MAX_PLAYLIST_ITEMS),
      ...(config.proxy ? ['--proxy', config.proxy] : []),
      ...(cookieFile ? ['--cookies', cookieFile] : []),
      '--', url,
    ];
    const child = spawn(ytdlp, args, { windowsHide: true, env: spawnEnv });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      if (cookieFile) fs.rmSync(cookieFile, { force: true });
      reject(e);
    });
    child.on('close', (code) => {
      if (cookieFile) fs.rmSync(cookieFile, { force: true });
      if (code !== 0) return reject(new Error(err.trim().split(/\r?\n/).at(-1) || `展开播放列表失败 (${code})`));
      try {
        const data = JSON.parse(out);
        const entries = (data.entries || [])
          .filter((e) => e && e.id && e.title !== '[Deleted video]' && e.title !== '[Private video]')
          .map((e) => ({
            url: `https://www.youtube.com/watch?v=${e.id}`,
            title: e.title || e.id,
          }));
        resolve({ title: data.title || '播放列表', entries });
      } catch (e) {
        reject(new Error('解析播放列表 JSON 失败'));
      }
    });
  });
}

function openInExplorer(targetPath, selectFile = false) {
  if (process.platform !== 'win32') return;
  // explorer.exe /select 从静默后台进程拉起时会被 Windows 拦截焦点，窗口藏在 Chrome 后面；
  // 改用 SHOpenFolderAndSelectItems 复用已有窗口选中文件，并通过 AttachThreadInput 置顶。
  const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(__dirname, 'open-explorer.ps1');
  const child = spawn(
    psExe,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, YTDL_TARGET: targetPath, YTDL_SELECT: selectFile ? '1' : '0' },
    },
  );
  let out = '';
  let errOut = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (errOut += d));
  child.on('error', (e) => console.error('[openInExplorer] spawn error:', e.message));
  child.on('close', (code) => {
    if (code !== 0 || errOut.trim()) console.error(`[openInExplorer] exit=${code}`, errOut.trim(), out.trim());
  });
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      // 带 Cookie 时请求体可能几 KB 到几十 KB，上限设 256KB
      if (d.length > 262144) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/health' && req.method === 'GET') {
      const all = [...jobs.values()];
      return send(res, 200, {
        ok: Boolean(ytdlpVersion),
        ytdlp: ytdlpVersion,
        ffmpeg: Boolean(ffmpegDir),
        config,
        outDir: config.outDir,
        activeCount: all.filter((j) => j.status === 'running' || j.status === 'retrying').length,
        queuedCount: all.filter((j) => j.status === 'queued').length,
      });
    }

    if (pathname === '/config' && req.method === 'GET') {
      return send(res, 200, config);
    }

    if (pathname === '/config' && req.method === 'POST') {
      const patch = JSON.parse((await readBody(req)) || '{}');
      config = validateConfigPatch(patch);
      saveConfig(config);
      pumpQueue();
      return send(res, 200, config);
    }

    if (pathname === '/jobs' && req.method === 'GET') {
      return send(res, 200, [...jobs.values()].reverse());
    }

    if (pathname === '/jobs/clear' && req.method === 'POST') {
      for (const [id, j] of jobs) {
        if (j.status === 'done' || j.status === 'error' || j.status === 'cancelled') {
          jobs.delete(id);
          jobCookies.delete(id);
        }
      }
      return send(res, 200, { ok: true });
    }

    const cancelMatch = pathname.match(/^\/jobs\/(\d+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      const job = jobs.get(cancelMatch[1]);
      if (!job) return send(res, 404, { error: '任务不存在' });
      if (job.status === 'queued' || job.status === 'running' || job.status === 'retrying') {
        job.status = 'cancelled';
        job.speed = '';
        job.eta = '';
        const rt = active.get(job.id);
        if (rt?.child) killProcessTree(rt.child);
        cleanupJobRuntime(job.id);
        pumpQueue();
      }
      return send(res, 200, { ok: true });
    }

    const retryMatch = pathname.match(/^\/jobs\/(\d+)\/retry$/);
    if (retryMatch && req.method === 'POST') {
      const job = jobs.get(retryMatch[1]);
      if (!job) return send(res, 404, { error: '任务不存在' });
      if (job.status === 'running' || job.status === 'retrying' || job.status === 'queued') {
        return send(res, 200, { ok: true, id: job.id });
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      if (typeof body.cookies === 'string' && body.cookies) jobCookies.set(job.id, body.cookies);
      job.status = 'queued';
      job.percent = 0;
      job.error = '';
      job.speed = '';
      job.eta = '';
      pumpQueue();
      return send(res, 200, { ok: true, id: job.id });
    }

    if (pathname === '/download' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const u = assertYouTube(body.url);
      const cookiesText = typeof body.cookies === 'string' ? body.cookies : '';
      const opts = {
        preset: body.preset,
        subtitles: body.subtitles,
        startTime: body.startTime,
        endTime: body.endTime,
      };

      if (body.playlist && u.searchParams.get('list')) {
        const listUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(u.searchParams.get('list'))}`;
        const pl = await expandPlaylist(listUrl, cookiesText);
        if (!pl.entries.length) throw new Error('播放列表为空或无法访问');
        // 播放列表批量下不套用片段起止时间
        const ids = pl.entries.map((item) =>
          enqueueJob(item.url, { preset: opts.preset, subtitles: opts.subtitles }, cookiesText, item.title),
        );
        return send(res, 200, { ids, count: ids.length, playlistTitle: pl.title });
      }

      const id = enqueueJob(u.href, opts, cookiesText);
      return send(res, 200, { id });
    }

    if (pathname === '/open' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.dir) {
        fs.mkdirSync(config.outDir, { recursive: true });
        openInExplorer(config.outDir, false);
        return send(res, 200, { ok: true });
      }
      const job = jobs.get(String(body.id || ''));
      if (!job || !job.file) return send(res, 404, { error: '找不到该任务的文件记录' });
      if (fs.existsSync(job.file)) {
        openInExplorer(job.file, true);
      } else {
        openInExplorer(path.dirname(job.file), false);
      }
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: String(e.message || e) });
  }
});

// 已有实例监听同端口时静默退出，避免开机/重复启动报错弹框
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`端口 ${PORT} 已有实例运行，跳过重复启动`);
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ytdl-ext 服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`  yt-dlp : ${ytdlpVersion ?? '未找到（pip install -U yt-dlp）'} [${ytdlp}]`);
  console.log(`  ffmpeg : ${ffmpegDir ?? '未找到（winget install Gyan.FFmpeg）'}`);
  console.log(`  代理   : ${config.proxy || '直连'}`);
  console.log(`  保存到 : ${config.outDir} (并发 ${config.maxConcurrent})`);
});
