// popup 和 content script 共用的工具函数与格式预设定义
const YTDL_PRESETS = [
  { id: 'ios', label: 'iOS 1080p MP4', short: 'iOS 1080p', desc: 'H.264/AAC，苹果设备直接播' },
  { id: 'best', label: '原画最高 (2K/4K)', short: '原画 4K', desc: '最高画质，含 VP9/AV1' },
  { id: '720p', label: '720p 省流 MP4', short: '720p', desc: '体积小，iOS 同样可播' },
  { id: 'mp3', label: '纯音频 MP3', short: 'MP3', desc: '仅提取最高音质 MP3' },
  { id: 'm4a', label: '纯音频 M4A', short: 'M4A', desc: 'iOS 原生音频，无二次重编码' },
];

const YTDL_DEFAULT_PREFS = {
  preset: 'ios',
  useCookies: true,
  subtitles: false,
};

function parseYouTubeUrl(raw) {
  try {
    const u = new URL(raw);
    if (!/(^|\.)(youtube\.com|youtu\.be)$/.test(u.hostname)) return null;
    const listId = u.searchParams.get('list') || null;
    if (u.hostname === 'youtu.be') {
      const videoId = u.pathname.slice(1).split('/')[0] || null;
      return videoId ? { videoId, listId, isShorts: false, isPlaylistOnly: false, url: `https://www.youtube.com/watch?v=${videoId}${listId ? `&list=${listId}` : ''}` } : null;
    }
    if (u.pathname === '/watch') {
      const videoId = u.searchParams.get('v') || null;
      if (!videoId) return null;
      return { videoId, listId, isShorts: false, isPlaylistOnly: false, url: `https://www.youtube.com/watch?v=${videoId}${listId ? `&list=${listId}` : ''}` };
    }
    if (u.pathname.startsWith('/shorts/')) {
      const videoId = u.pathname.split('/')[2] || null;
      if (!videoId) return null;
      return { videoId, listId: null, isShorts: true, isPlaylistOnly: false, url: `https://www.youtube.com/watch?v=${videoId}` };
    }
    if (u.pathname === '/playlist' && listId) {
      return { videoId: null, listId, isShorts: false, isPlaylistOnly: true, url: `https://www.youtube.com/playlist?list=${listId}` };
    }
    return null;
  } catch {
    return null;
  }
}

function presetLabelOf(id) {
  return YTDL_PRESETS.find((p) => p.id === id)?.short || 'iOS 1080p';
}
