// "창 위에 걸터앉기": the character sits on the top edge of the window in front (Windows).
// A small helper process (PowerShell + Win32 calls) reports the foreground window's rectangle;
// perchPlacement() (pure, unit-tested) decides where to sit or whether to go back to the taskbar.
const { spawn } = require('node:child_process');

// C#: polls every 150 ms and prints, when something changes (physical px):
//   F hwnd x y w h zoomed full quns   the window in front ("F none quns" for none). full = it covers
//                                     its monitor; quns = SHQueryUserNotificationState (3 = D3D fullscreen)
//   T hwnd x y w h zoomed             the tracked window (a perch the user dropped the character on),
//                                     "T gone" once it is closed, minimized or hidden
//   L hwnd x y w h ... then "L end"   all visible windows front to back, after a "list" command
// Commands on stdin: "list", "track <hwnd>" ("track 0" stops). Own windows, the desktop, the taskbar,
// minimized and cloaked windows are skipped.
const WATCHER_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class DancerPerch {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int n);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int n);
  static readonly string[] Skip = { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow", "Windows.UI.Core.CoreWindow" };
  static uint own;
  static volatile bool wantList;
  static long tracked;

  // a normal app window we could sit on (or that could be fullscreen); r = its visible frame
  static bool Usable(IntPtr h, out RECT r) {
    r = new RECT();
    if (h == IntPtr.Zero || !IsWindowVisible(h) || IsIconic(h)) return false;
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid == own) return false;
    var cls = new StringBuilder(256);
    GetClassName(h, cls, 256);
    if (Array.IndexOf(Skip, cls.ToString()) >= 0) return false;
    int cloaked = 0;
    DwmGetWindowAttribute(h, 14, out cloaked, 4);
    if (cloaked != 0) return false;
    if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r); // frame without the shadow
    return r.R - r.L > 50 && r.B - r.T > 50;
  }
  static string Rect(IntPtr h, RECT r) {
    return h.ToInt64() + " " + r.L + " " + r.T + " " + (r.R - r.L) + " " + (r.B - r.T);
  }
  static bool CoversMonitor(IntPtr h, RECT r) {
    var mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;
    return r.L <= mi.rcMonitor.L + 2 && r.T <= mi.rcMonitor.T + 2 && r.R >= mi.rcMonitor.R - 2 && r.B >= mi.rcMonitor.B - 2;
  }
  static void Say(string s) { Console.Out.WriteLine(s); Console.Out.Flush(); }

  public static void Run(uint ownPid) {
    own = ownPid;
    SetProcessDpiAwarenessContext(new IntPtr(-4)); // per-monitor v2: physical pixels
    new Thread(() => {
      string cmd;
      while ((cmd = Console.In.ReadLine()) != null) {
        cmd = cmd.Trim();
        if (cmd == "list") wantList = true;
        else if (cmd.StartsWith("track ")) { long v; if (long.TryParse(cmd.Substring(6), out v)) Interlocked.Exchange(ref tracked, v); }
      }
      Environment.Exit(0);
    }) { IsBackground = true }.Start();
    string lastF = null, lastT = null;
    while (true) {
      int quns = 0;
      SHQueryUserNotificationState(out quns);
      IntPtr h = GetForegroundWindow();
      RECT r;
      string f = Usable(h, out r)
        ? "F " + Rect(h, r) + " " + (IsZoomed(h) ? 1 : 0) + " " + (CoversMonitor(h, r) ? 1 : 0) + " " + quns
        : "F none " + quns;
      if (f != lastF) { Say(f); lastF = f; }

      long tv = Interlocked.Read(ref tracked);
      string t = null;
      if (tv != 0) {
        IntPtr th = new IntPtr(tv);
        t = IsWindow(th) && Usable(th, out r) ? "T " + Rect(th, r) + " " + (IsZoomed(th) ? 1 : 0) : "T gone";
      }
      if (t != null && t != lastT) Say(t);
      lastT = t;

      if (wantList) {
        wantList = false;
        var lines = new List<string>();
        EnumWindows((w, l) => {
          RECT wr;
          if (GetWindowTextLength(w) > 0 && Usable(w, out wr)) lines.Add("L " + Rect(w, wr));
          return lines.Count < 200;
        }, IntPtr.Zero);
        foreach (var line in lines) Say(line);
        Say("L end");
      }
      Thread.Sleep(150);
    }
  }
}`;

/**
 * Starts the watcher (Windows only). Handlers get physical-pixel rectangles:
 *   onForeground({ hwnd, x, y, width, height, zoomed, full, quns } | { none: true, quns })
 *   onTracked(rect | null)    onList([rect, ...]) (front to back)
 * Returns { stop(), list(), track(hwnd) }.
 */
function startWatcher(ownPid, handlers, log = console.error) {
  const noop = { stop() {}, list() {}, track() {} };
  if (process.platform !== 'win32') return noop;
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
    log('window watcher failed to start', e);
    return noop;
  }
  let buf = '';
  let listing = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const m = parseMessage(line);
      if (!m) continue;
      if (m.kind === 'F') handlers.onForeground?.(m.value);
      else if (m.kind === 'T') handlers.onTracked?.(m.value);
      else if (m.kind === 'L') listing.push(m.value);
      else if (m.kind === 'Lend') {
        handlers.onList?.(listing);
        listing = [];
      }
    }
  });
  child.stderr.on('data', (d) => log('window watcher:', String(d).trim()));
  child.on('error', (e) => log('window watcher error', e));
  const send = (cmd) => {
    try {
      child.stdin.write(`${cmd}\n`);
    } catch {
      /* gone */
    }
  };
  return {
    stop() {
      try {
        child.stdin.end();
        child.kill();
      } catch {
        /* already gone */
      }
    },
    list: () => send('list'),
    track: (hwnd) => send(`track ${Number(hwnd) || 0}`),
  };
}

/** One watcher line -> { kind: 'F' | 'T' | 'L' | 'Lend', value } or null. */
function parseMessage(line) {
  const p = String(line).trim().split(/\s+/);
  const rect = (a) => {
    const [hwnd, x, y, width, height] = a.map(Number);
    return [hwnd, x, y, width, height].every(Number.isFinite) ? { hwnd, x, y, width, height } : null;
  };
  if (p[0] === 'F') {
    if (p[1] === 'none') return { kind: 'F', value: { none: true, quns: Number(p[2]) || 0 } };
    const r = p.length === 9 ? rect(p.slice(1, 6)) : null;
    return r ? { kind: 'F', value: { ...r, zoomed: p[6] === '1', full: p[7] === '1', quns: Number(p[8]) || 0 } } : null;
  }
  if (p[0] === 'T') {
    if (p[1] === 'gone') return { kind: 'T', value: null };
    const r = p.length === 7 ? rect(p.slice(1, 6)) : null;
    return r ? { kind: 'T', value: { ...r, zoomed: p[6] === '1' } } : null;
  }
  if (p[0] === 'L') {
    if (p[1] === 'end') return { kind: 'Lend' };
    const r = p.length === 6 ? rect(p.slice(1, 6)) : null;
    return r ? { kind: 'L', value: r } : null;
  }
  return null;
}

/**
 * 게임 모드: should the character hide? True when the window in front covers the character's monitor
 * (a fullscreen game or video), or Windows reports a Direct3D fullscreen app / presentation mode.
 */
function shouldHideFor(fg, displayBoundsPx) {
  if (!fg) return false;
  if (fg.quns === 3 || fg.quns === 4) return true; // QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE
  // a maximized window can cover the monitor too (auto-hide taskbar): that is not fullscreen
  if (fg.none || !fg.full || fg.zoomed) return false;
  if (!displayBoundsPx) return true;
  // only when it is on the character's monitor (centers inside)
  const cx = fg.x + fg.width / 2, cy = fg.y + fg.height / 2;
  const b = displayBoundsPx;
  return cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
}

/**
 * Dropped the character with its feet at (fx, fy) (DIP): the window whose top edge it was dropped on,
 * or null. windows: DIP rects front to back. The edge must be within `snap` px and not hidden behind
 * a window in front of it.
 */
function dropTarget(windows, fx, fy, snap = 40) {
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    if (fx < w.x + 10 || fx > w.x + w.width - 10) continue;
    if (Math.abs(fy - w.y) > snap) continue;
    const covered = windows.slice(0, i).some((o) => fx >= o.x && fx <= o.x + o.width && w.y + 2 >= o.y && w.y + 2 <= o.y + o.height);
    if (!covered) return w;
  }
  return null;
}

/**
 * Where to sit on a window (DIP rect), or null to stay on the taskbar.
 *  - display: the Electron display the window is on; frame: { w, h } of the character's frame (px)
 *  - centerX: the character's current center (screen px), kept if it is over the window
 *  - manual: the user dropped it there (any visible edge will do, not only a comfortable one)
 * Returns { floorY (screen y of the seat), centerX }.
 */
function perchPlacement(rect, display, frame, centerX, { manual = false } = {}) {
  if (!rect || rect.zoomed) return null;
  const wa = display.workArea;
  const b = display.bounds;
  // fullscreen or nearly so: nowhere to sit
  if (rect.width >= b.width - 4 && rect.height >= b.height - 4) return null;
  if (rect.width >= wa.width - 4 && rect.height >= wa.height - 4) return null;
  // too narrow for the character, or the top edge off screen / so high the character would not show
  if (rect.width < frame.w * 0.45) return null;
  // (dropped there by hand: any edge that is on screen)
  if (manual ? rect.y < wa.y || rect.y > wa.y + wa.height - 10 : rect.y < wa.y + frame.h * 0.35 || rect.y > wa.y + wa.height - 40) return null;
  const margin = Math.min(frame.w * 0.3, rect.width / 2);
  const lo = rect.x + margin;
  const hi = rect.x + rect.width - margin;
  const cx = Math.min(hi, Math.max(lo, centerX));
  // sit with the hips a few px into the title bar, so it looks like sitting on it, not floating
  return { floorY: Math.round(rect.y + 4), centerX: Math.round(cx) };
}

module.exports = { startWatcher, perchPlacement, parseMessage, shouldHideFor, dropTarget };
