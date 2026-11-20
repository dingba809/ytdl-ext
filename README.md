# YouTube 下载器（Chrome 扩展 + 本地 yt-dlp）

Chrome 扩展负责界面与登录态获取，本地静默服务负责调用 `yt-dlp` + `ffmpeg` 完成下载与合并。

## 功能

- **静默开机自启**：运行一次 `server/install-autostart.cmd`，以后开机无黑窗后台运行，不再手动启服务。
- **多种画质与格式预设**：`iOS 1080p MP4 (H.264/AAC)`、`原画最高 (2K/4K)`、`720p 省流 MP4`、`纯音频 MP3`、`纯音频 M4A`，记住上次选择。
- **任务队列管理**：支持并发（默认 2 个）、实时速度/大小/剩余时间、取消下载、失败重试、完成后一键在资源管理器定位文件，扩展图标显示进行中数量角标。
- **自动带 Chrome 登录态**：自动读取当前浏览器的 YouTube Cookie（每次下载用临时文件传入、结束后立即删除，不落盘留存），支持年龄限制、会员和防爬验证视频。
- **进阶功能**：可选同步下载中英字幕（`.srt`）、按起止时间截取片段、识别播放列表批量入队（单次最多 50 条）、弹窗内直接配置保存目录/代理/并发数。
- **页面内交互**：支持普通播放页（带格式下拉菜单的胶囊按钮）和 Shorts 页面，切视频自动重置状态，下载完成后点击按钮直接打开文件位置。

## 安装与使用

1. **依赖**（本机已安装，换机时重跑）：
   ```bash
   pip install -U yt-dlp yt-dlp-ejs
   winget install ffmpeg
   ```
2. **启用后台静默自启**：双击 `server/install-autostart.cmd`（卸载请双击 `server/uninstall-autostart.cmd`）。
   - 如需看实时控制台日志调试，可先卸载或停掉后台后运行 `server/start.cmd`。
3. **加载 / 刷新扩展**：打开 `chrome://extensions` → 开发者模式 →「加载已解压的扩展程序」选 `extension/`（已加载过的直接点刷新图标即可，v2 新增了 `cookies`/`storage` 权限）。

## 目录结构

```
server/
  server.mjs              本地 HTTP 服务（127.0.0.1:8877）
  open-explorer.ps1       打开资源管理器选中文件并置顶窗口
  config.json             运行时自动生成的设置（保存目录/代理/并发数）
  start-silent.vbs        无黑窗静默启动脚本
  install-autostart.cmd   注册 Windows 开机静默自启并立即启动
  uninstall-autostart.cmd 移除开机自启并停止后台服务
  start.cmd               前台调试启动
extension/
  manifest.json           MV3 扩展清单
  lib.js                  URL 解析与格式预设
  background.js           本地服务代理、Cookie 导出与图标角标
  popup.html / popup.js   三标签面板（下载 / 任务 / 设置）
  content.js              YouTube 播放页与 Shorts 页面按钮注入
```

## 安全与限制

- 本地服务仅绑定 `127.0.0.1` 且不返回 CORS 头，普通网页无法调用；下载接口仅接受 `youtube.com` / `youtu.be` 链接。
- Cookie 仅在内存中暂存给重试并在下载结束/取消/失败后连同临时文件立即销毁，不会写入日志或出现在 `/jobs` 响应中。
- iOS 兼容预设画质上限为 1080p（YouTube 的 2K/4K 仅提供 VP9/AV1）；需要 2K/4K 时切换为「原画最高 (2K/4K)」。
- 任务历史保存在内存中（最多保留最近 50 条），重启服务后清空；单次播放列表展开上限 50 条。
