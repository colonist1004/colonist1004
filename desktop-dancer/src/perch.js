// "창 위에 걸터앉기": the character sits on the top edge of the window in front (Windows).
// A small helper process (PowerShell + Win32 calls) reports the foreground window's rectangle;
// perchPlacement() (pure, unit-tested) decides where to sit or whether to go back to the taskbar.
const { spawn } = require('node:child_process');

// C#: polls the foreground window every 150 ms and prints "hwnd x y w h zoomed" (physical px) when it
// changes, or "none". Own windows, the desktop, the taskbar, minimized and cloaked windows are "none".
const WATCHER_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class DancerPerch {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int n);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int n);
  static readonly string[] Skip = { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow", "Windows.UI.Core.CoreWindow" };
  public static void Run(uint ownPid) {
    SetProcessDpiAwarenessContext(new IntPtr(-4)); // per-monitor v2: physical pixels
    new Thread(() => { while (Console.In.ReadLine() != null) { } Environment.Exit(0); }) { IsBackground = true }.Start();
    string last = null;
    while (true) {
      string line = "none";
      IntPtr h = GetForegroundWindow();
      uint pid;
      if (h != IntPtr.Zero && IsWindowVisible(h) && !IsIconic(h)) {
        GetWindowThreadProcessId(h, out pid);
        var cls = new StringBuilder(256);
        GetClassName(h, cls, 256);
        int cloaked = 0;
        DwmGetWindowAttribute(h, 14, out cloaked, 4);
        RECT r;
        if (pid != ownPid && Array.IndexOf(Skip, cls.ToString()) < 0 && cloaked == 0) {
          if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r); // frame without the shadow
          if (r.R - r.L > 50 && r.B - r.T > 50)
            line = h.ToInt64() + " " + r.L + " " + r.T + " " + (r.R - r.L) + " " + (r.B - r.T) + " " + (IsZoomed(h) ? 1 : 0);
        }
      }
      if (line != last) { Console.Out.WriteLine(line); Console.Out.Flush(); last = line; }
      Thread.Sleep(150);
    }
  }
}`;

/**
 * Starts the watcher (Windows only). onWindow({ hwnd, x, y, width, height, zoomed } | null) gets
 * physical-pixel rectangles. Returns stop().
 */
function startWatcher(ownPid, onWindow, log = console.error) {
  if (process.platform !== 'win32') return () => {};
  const script =
    `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WATCHER_CS}\n'@; [DancerPerch]::Run(${Number(ownPid) >>> 0})`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  let child;
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    log('perch watcher failed to start', e);
    return () => {};
  }
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      onWindow(parseLine(line));
    }
  });
  child.stderr.on('data', (d) => log('perch watcher:', String(d).trim()));
  child.on('error', (e) => log('perch watcher error', e));
  return () => {
    try {
      child.stdin.end();
      child.kill();
    } catch {
      /* already gone */
    }
  };
}

function parseLine(line) {
  const p = String(line).trim().split(/\s+/);
  if (p.length !== 6) return null;
  const [hwnd, x, y, width, height, zoomed] = p.map(Number);
  if (![hwnd, x, y, width, height].every(Number.isFinite)) return null;
  return { hwnd, x, y, width, height, zoomed: zoomed === 1 };
}

/**
 * Where to sit on a window (DIP rect), or null to stay on the taskbar.
 *  - display: the Electron display the window is on; frame: { w, h } of the character's frame (px)
 *  - centerX: the character's current center (screen px), kept if it is over the window
 * Returns { floorY (screen y of the seat), centerX }.
 */
function perchPlacement(rect, display, frame, centerX) {
  if (!rect || rect.zoomed) return null;
  const wa = display.workArea;
  const b = display.bounds;
  // fullscreen or nearly so: nowhere to sit
  if (rect.width >= b.width - 4 && rect.height >= b.height - 4) return null;
  if (rect.width >= wa.width - 4 && rect.height >= wa.height - 4) return null;
  // too narrow for the character, or the top edge off screen / so high the character would not show
  if (rect.width < frame.w * 0.45) return null;
  if (rect.y < wa.y + frame.h * 0.35 || rect.y > wa.y + wa.height - 40) return null;
  const margin = Math.min(frame.w * 0.3, rect.width / 2);
  const lo = rect.x + margin;
  const hi = rect.x + rect.width - margin;
  const cx = Math.min(hi, Math.max(lo, centerX));
  // sit with the hips a few px into the title bar, so it looks like sitting on it, not floating
  return { floorY: Math.round(rect.y + 4), centerX: Math.round(cx) };
}

module.exports = { startWatcher, perchPlacement, parseLine };
