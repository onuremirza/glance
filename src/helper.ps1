# Glance - backend helper
# Long-running process. Reads commands from stdin (one per line), writes results to stdout.
# Protocol:
#   stdin  "SNAP"          -> stdout "SNAP:<json>"   (one snapshot of all claude.exe sessions)
#   stdin  "FOCUS:<hwnd>"  -> brings that window to the foreground, replies "FOCUS:ok" / "FOCUS:err"
#   stdin  "EXIT"          -> quits
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Native {
  [StructLayout(LayoutKind.Sequential)]
  struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Upid; public IntPtr R3; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI pbi, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int read);
  static byte[] R(IntPtr h, IntPtr a, int n){ byte[] b=new byte[n]; int r; ReadProcessMemory(h,a,b,n,out r); return b; }

  public static string GetCwd(int pid){
    IntPtr h = OpenProcess(0x0410, false, pid); // PROCESS_VM_READ | PROCESS_QUERY_INFORMATION
    if(h==IntPtr.Zero) return "";
    try{
      var pbi=new PBI(); int ret;
      if(NtQueryInformationProcess(h,0,ref pbi,Marshal.SizeOf(pbi),out ret)!=0) return "";
      IntPtr pp = (IntPtr)BitConverter.ToInt64(R(h,(IntPtr)((long)pbi.Peb+0x20),8),0);   // PEB->ProcessParameters
      ushort len = BitConverter.ToUInt16(R(h,(IntPtr)((long)pp+0x38),2),0);              // CurDir.DosPath.Length
      IntPtr buf = (IntPtr)BitConverter.ToInt64(R(h,(IntPtr)((long)pp+0x40),8),0);       // CurDir.DosPath.Buffer
      if(len==0||buf==IntPtr.Zero) return "";
      return Encoding.Unicode.GetString(R(h,buf,len));
    } catch { return ""; } finally { CloseHandle(h); }
  }

  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);

  // Shared-process terminals (VS Code, Windows Terminal) give one MainWindowHandle
  // for all their windows. Pick the host's visible top-level window whose TITLE
  // matches the session's cwd (VS Code shows the workspace folder; WT shows the
  // active tab dir) so the RIGHT project window is focused. Falls back to `fallback`.
  public static long BestWindow(int pid, string cwd, long fallback){
    // Tüm eş-pencereleri TARA ve EN DERİN cwd segmentiyle eşleşeni seç. İlk-eşleşmede
    // durmak yanlış pencereyi seçebiliyordu: sığ bir segment ("Projects") derin olandan
    // ("glance") önce enumere edilirse kazanıyordu. En spesifik (i büyük) eşleşme kazansın.
    long best = 0; int bestScore = -1;
    string[] segs = (cwd ?? "").Split(new char[]{'\\','/'}, StringSplitOptions.RemoveEmptyEntries);
    EnumWindows((h, l) => {
      if(!IsWindowVisible(h)) return true;
      uint wp; GetWindowThreadProcessId(h, out wp);
      if((int)wp != pid) return true;
      int len = GetWindowTextLength(h);
      if(len <= 0) return true;
      var sb = new StringBuilder(len+1);
      GetWindowText(h, sb, sb.Capacity);
      string t = sb.ToString();
      for(int i=segs.Length-1; i>=0 && i>=segs.Length-3; i--){ // last up to 3 path segments
        if(segs[i].Length > 2 && t.IndexOf(segs[i], StringComparison.OrdinalIgnoreCase) >= 0){
          if(i > bestScore){ bestScore = i; best = (long)h; } // bu pencerenin en derin eşleşmesi; global en derini tut
          break;
        }
      }
      return true; // erken çıkma — tüm pencereleri değerlendir
    }, IntPtr.Zero);
    return best != 0 ? best : fallback;
  }

  // Bring a window to the foreground. Never hides/closes: only restores if
  // minimized, then activates. Guarded by IsWindow so a stale handle is a no-op.
  public static bool Focus(long hwnd){
    IntPtr h = (IntPtr)hwnd;
    if(h==IntPtr.Zero || !IsWindow(h)) return false;
    if(IsIconic(h)) ShowWindow(h,9); // SW_RESTORE (only when minimized)
    uint tmp;
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out tmp);
    uint cur = GetCurrentThreadId();
    bool attached = (fg != 0 && fg != cur && AttachThreadInput(cur, fg, true));
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    if(attached) AttachThreadInput(cur, fg, false);
    return ok;
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp | Out-Null

function Get-Snapshot {
  $procs = Get-CimInstance Win32_Process -Filter "Name='claude.exe'"
  if (-not $procs) { return '{"sessions":[]}' }

  # Only real, top-level interactive sessions. Drop claude.exe processes that are
  # children of another claude.exe (subagents / Task workers / workflow agents) —
  # they aren't user sessions and would otherwise appear as extra dots on the same
  # terminal. Also drop obvious headless invocations (claude -p / --print).
  $claudePids = @($procs | ForEach-Object { [int]$_.ProcessId })
  $procs = @($procs | Where-Object {
    ($claudePids -notcontains [int]$_.ParentProcessId) -and
    ("$($_.CommandLine)" -notmatch '(?i)(^|\s)(-p|--print)(\s|$)')
  })
  if ($procs.Count -eq 0) { return '{"sessions":[]}' }

  # Build parent map + window-handle map once (covers ancestry walk to the terminal window).
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
  $parent = @{}; $pname = @{}
  foreach ($p in $all) { $parent[[int]$p.ProcessId] = [int]$p.ParentProcessId; $pname[[int]$p.ProcessId] = $p.Name }
  $winmap = @{}
  foreach ($g in Get-Process) {
    if ($g.MainWindowHandle -ne 0) { $winmap[[int]$g.Id] = [int64]$g.MainWindowHandle }
  }

  $sessions = @()
  foreach ($p in $procs) {
    $pid0 = [int]$p.ProcessId
    # Walk up to the first ancestor that owns a visible window (VS Code / Windows Terminal / console host).
    $hwnd = 0; $winName = ""; $winPid = 0; $cur = $pid0; $depth = 0
    while ($cur -and $depth -lt 10) {
      if ($winmap.ContainsKey($cur)) { $hwnd = $winmap[$cur]; $winName = $pname[$cur]; $winPid = $cur; break }
      if (-not $parent.ContainsKey($cur)) { break }
      $next = $parent[$cur]
      if ($next -eq $cur -or $next -eq 0) { break }
      $cur = $next; $depth++
    }
    $cwd = [Native]::GetCwd($pid0)
    # Shared-process host (VS Code/WT) → refine to the window matching this session's cwd.
    if ($winPid -gt 0 -and $hwnd -ne 0 -and $cwd) { $hwnd = [Native]::BestWindow($winPid, $cwd, $hwnd) }
    # CPU + I/O metrics for busy/waiting detection.
    $cpuMs = 0.0
    $gp = Get-Process -Id $pid0 -ErrorAction SilentlyContinue
    if ($gp) { try { $cpuMs = $gp.TotalProcessorTime.TotalMilliseconds } catch {} }
    $io = ($p.ReadTransferCount + $p.WriteTransferCount + $p.OtherTransferCount)
    $created = 0
    try { $created = [int64]([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } catch {}
    $sessions += [pscustomobject]@{
      pid     = $pid0
      ppid    = [int]$p.ParentProcessId
      cwd     = $cwd
      cmd     = "$($p.CommandLine)"
      created = $created
      hwnd    = $hwnd
      host    = $winName
      cpuMs   = [math]::Round($cpuMs, 1)
      io      = [int64]$io
    }
  }
  return (@{ sessions = $sessions } | ConvertTo-Json -Compress -Depth 5)
}

# Signal readiness, then serve requests.
[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { Start-Sleep -Milliseconds 50; continue }
  $line = $line.Trim()
  if ($line -eq "") { continue }
  try {
    if ($line -eq "SNAP") {
      $json = Get-Snapshot
      [Console]::Out.WriteLine("SNAP:$json")
    } elseif ($line.StartsWith("FOCUS:")) {
      $hwnd = 0; [void][int64]::TryParse($line.Substring(6), [ref]$hwnd)
      $ok = [Native]::Focus($hwnd)
      [Console]::Out.WriteLine("FOCUS:" + ($(if ($ok) { "ok" } else { "err" })))
    } elseif ($line -eq "EXIT") {
      break
    }
  } catch {
    [Console]::Out.WriteLine("ERR:" + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
