$ErrorActionPreference = 'SilentlyContinue'
$target = $env:YTDL_TARGET
if (-not $target) { exit 0 }
$select = ($env:YTDL_SELECT -eq '1')
$dir = if ($select) { Split-Path -Parent $target } else { $target }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinBring {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  public static extern int SHParseDisplayName(string pszName, IntPtr pbc, out IntPtr ppidl, uint sfgaoIn, out uint psfgaoOut);
  [DllImport("shell32.dll")]
  public static extern int SHOpenFolderAndSelectItems(IntPtr pidlFolder, uint cidl, IntPtr[] apidl, uint dwFlags);
  [DllImport("shell32.dll")]
  public static extern void ILFree(IntPtr pidl);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$shell = New-Object -ComObject Shell.Application
$normDir = $dir.TrimEnd('\')

if ($select) {
  [IntPtr]$pidl = [IntPtr]::Zero
  [uint32]$sfgao = 0
  if ([WinBring]::SHParseDisplayName($target, [IntPtr]::Zero, [ref]$pidl, 0, [ref]$sfgao) -eq 0 -and $pidl -ne [IntPtr]::Zero) {
    [void][WinBring]::SHOpenFolderAndSelectItems($pidl, 0, $null, 0)
    [WinBring]::ILFree($pidl)
  } else {
    Start-Process explorer.exe -ArgumentList @('/select,', $target)
  }
} else {
  $existing = $shell.Windows() | Where-Object {
    try { $_.Document.Folder.Self.Path.TrimEnd('\') -ieq $normDir } catch { $false }
  } | Select-Object -First 1
  if (-not $existing) { $shell.Open($normDir) }
}

$targetName = if ($select) { Split-Path -Leaf $target } else { $null }
$win = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 100
  $matches = @($shell.Windows() | Where-Object {
    try { $_.Document.Folder.Self.Path.TrimEnd('\') -ieq $normDir } catch { $false }
  })
  if ($matches.Count -gt 0) {
    if ($targetName) {
      $win = $matches | Where-Object {
        try { @($_.Document.SelectedItems() | Where-Object { $_.Name -ieq $targetName }).Count -gt 0 } catch { $false }
      } | Select-Object -First 1
    }
    if (-not $win) { $win = $matches[-1] }
    break
  }
}

if ($win) {
  $h = [IntPtr]$win.HWND
  $fg = [WinBring]::GetForegroundWindow()
  [uint32]$procId = 0
  $fgThread = if ($fg -ne [IntPtr]::Zero) { [WinBring]::GetWindowThreadProcessId($fg, [ref]$procId) } else { 0 }
  $curThread = [WinBring]::GetCurrentThreadId()
  $attached = $false
  if ($fgThread -ne 0 -and $fgThread -ne $curThread) {
    $attached = [WinBring]::AttachThreadInput($curThread, $fgThread, $true)
  }
  [void][WinBring]::ShowWindow($h, 9)
  [void][WinBring]::BringWindowToTop($h)
  [void][WinBring]::SetForegroundWindow($h)
  if ($attached) { [void][WinBring]::AttachThreadInput($curThread, $fgThread, $false) }
}
