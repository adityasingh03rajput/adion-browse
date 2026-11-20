# Adion Browse — Windows input sidecar (the only process that presses keys)
#
# Adapted from nus-companion's reflex/hands.ps1 (Apache-2.0,
# potlakai/nus-companion v0.1.21), renamed and trimmed. The read-only probe
# (probe.ps1) is deliberately a different process: its promise is that it never
# sends input, and that promise is tested. This one is started only when the PC
# feature is enabled AND an action has already passed src/control-plane/
# actionConsent.js.
#
# JSON lines in, JSON lines out.
#   {"id":1,"op":"ping"}
#   {"id":2,"op":"keys.text","text":"hello","enter":false,"hwnd":123}
#   {"id":3,"op":"keys.chord","keys":[17,83]}              Ctrl+S
#   {"id":4,"op":"keys.press","keys":[13]}
#   {"id":5,"op":"mouse.click","x":100,"y":200,"button":"left","twice":false}
#   {"id":6,"op":"mouse.move","x":100,"y":200}
#   {"id":7,"op":"mouse.scroll","x":100,"y":200,"dy":-3}
#   {"id":8,"op":"mouse.drag","x0":1,"y0":2,"x1":3,"y1":4}
#   {"id":9,"op":"win.activate","hwnd":123,"mustContain":"Notepad"}
#   {"id":10,"op":"focus.read"}                            focused field's own text
#
# Refusals: keys.text and mouse.click refuse a password field. That is enforced
# here, in code, not asked of the model.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AdionInput {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  public static string Title(IntPtr h) { var sb = new System.Text.StringBuilder(1024); GetWindowTextW(h, sb, 1024); return sb.ToString(); }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static uint FgPid() { uint p = 0; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
  // Windows only lets a process take the foreground if it just received input.
  // A tap of Alt is that input; it is the documented way round the focus lock.
  public static bool Activate(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    return GetForegroundWindow() == h;
  }
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
  const uint MOVE = 0x0001, ABS = 0x8000, VDESK = 0x4000, LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, MDOWN = 0x0020, MUP = 0x0040, WHEEL = 0x0800, HWHEEL = 0x1000;
  const uint KEYUP = 0x0002, UNICODE = 0x0004;
  static INPUT Mouse(uint flags, int dx, int dy, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags; return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  static void Send(params INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }
  public static void Chord(int[] vks) {
    foreach (int v in vks) keybd_event((byte)v, 0, 0, UIntPtr.Zero);
    for (int i = vks.Length - 1; i >= 0; i--) keybd_event((byte)vks[i], 0, 2, UIntPtr.Zero);
  }
  // Text as one burst of Unicode key events (SendKeys.SendWait took ~10 s for
  // 160 characters; this takes milliseconds). Newlines and tabs go as Enter and
  // Tab so every editor takes them. Returns how many events Windows accepted.
  public static int Text(string s) {
    var list = new System.Collections.Generic.List<INPUT>();
    int accepted = 0, size = Marshal.SizeOf(typeof(INPUT));
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') { list.Add(Key(0x0D, 0, 0)); list.Add(Key(0x0D, 0, KEYUP)); }
      else if (c == '\t') { list.Add(Key(0x09, 0, 0)); list.Add(Key(0x09, 0, KEYUP)); }
      else { list.Add(Key(0, c, UNICODE)); list.Add(Key(0, c, UNICODE | KEYUP)); }
      if (list.Count >= 64) { accepted += (int)SendInput((uint)list.Count, list.ToArray(), size); list.Clear(); System.Threading.Thread.Sleep(5); }
    }
    if (list.Count > 0) accepted += (int)SendInput((uint)list.Count, list.ToArray(), size);
    return accepted;
  }
  // Absolute coordinates on the virtual desktop run 0..65535 across every monitor.
  static INPUT MoveTo(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int ax = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1)), ay = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    return Mouse(MOVE | ABS | VDESK, ax, ay, 0);
  }
  public static void Move(int x, int y) { Send(MoveTo(x, y)); }
  public static void Click(int x, int y, string button, bool twice, bool restoreUser = true) {
    POINT original = new POINT();
    bool hasOriginal = restoreUser && GetCursorPos(out original);
    uint down = LDOWN, up = LUP;
    if (button == "right") { down = RDOWN; up = RUP; } else if (button == "middle") { down = MDOWN; up = MUP; }
    Send(MoveTo(x, y));
    System.Threading.Thread.Sleep(25);
    Send(Mouse(down, 0, 0, 0), Mouse(up, 0, 0, 0));
    if (twice) { System.Threading.Thread.Sleep(50); Send(Mouse(down, 0, 0, 0), Mouse(up, 0, 0, 0)); }
    if (hasOriginal) {
      System.Threading.Thread.Sleep(20);
      SetCursorPos(original.X, original.Y);
    }
  }
  public static void Scroll(int x, int y, int dy, int dx) {
    Send(MoveTo(x, y));
    System.Threading.Thread.Sleep(20);
    if (dy != 0) Send(Mouse(WHEEL, 0, 0, unchecked((uint)(dy * 120))));
    if (dx != 0) Send(Mouse(HWHEEL, 0, 0, unchecked((uint)(dx * 120))));
  }
  public static void Drag(int x0, int y0, int x1, int y1, int steps) {
    Send(MoveTo(x0, y0)); System.Threading.Thread.Sleep(40);
    Send(Mouse(LDOWN, 0, 0, 0)); System.Threading.Thread.Sleep(60);
    for (int i = 1; i <= steps; i++) { Send(MoveTo(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)); System.Threading.Thread.Sleep(16); }
    System.Threading.Thread.Sleep(60); Send(Mouse(LUP, 0, 0, 0));
  }
}
"@
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]

# Keys this sidecar will press: modifiers, navigation, function keys, letters,
# digits and punctuation. Never the Windows key alone.
$PressVk = @(0x08,0x09,0x0D,0x10,0x11,0x12,0x1B,0x20,0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2E,0x2C,0x5B,0x70,0x71,0x72,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7A,0x7B,0xAD,0xAE,0xAF,0xB3) + @(0x30..0x39) + @(0x41..0x5A) + @(0xBB,0xBD,0xBC,0xBE,0xBF,0xC0,0xDB,0xDC,0xDD,0xDE)

function Out-Line($obj) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 4))
  [Console]::Out.Flush()
}

# Keys go to the window the caller named, never to whatever happens to be in
# front (an app it just opened may still be coming up).
function Ensure-Target($req) {
  $refocused = $false
  if ($req.hwnd) {
    $h = [IntPtr][int64]$req.hwnd
    if ([AdionInput]::IsWindow($h) -and [AdionInput]::GetForegroundWindow() -ne $h) {
      [void][AdionInput]::Activate($h); Start-Sleep -Milliseconds 80; $refocused = $true
    }
  }
  $fg = [AdionInput]::GetForegroundWindow()
  $name = ''; $type = ''; $pw = $false
  try {
    $f = $AE::FocusedElement
    if ($f) { $name = [string]$f.Current.Name; $type = [string]$f.Current.LocalizedControlType; try { $pw = [bool]$f.Current.IsPassword } catch {} }
  } catch {}
  return @{ window = [AdionInput]::Title($fg); focus = $name; focusType = $type; refocused = $refocused; isPassword = $pw }
}

# The focused field's own text, read-only, for checking that a type landed.
function Read-FocusedText() {
  try {
    $f = $AE::FocusedElement
    if (-not $f) { return $null }
    try { if ([bool]$f.Current.IsPassword) { return $null } } catch {}
    $vp = $null
    if ($f.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return [string]$vp.Current.Value }
    $tp = $null
    if ($f.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { return [string]$tp.DocumentRange.GetText(6000) }
  } catch {}
  return $null
}

function Handle($req) {
  switch ([string]$req.op) {
    'ping' { return @{ ok=$true; pid=$PID } }
    'keys.text' {
      $target = Ensure-Target $req
      # A password box is never typed into by the agent. Enforced here.
      if ($target.isPassword) { return @{ ok=$false; refused='password field'; window=$target.window } }
      $text = [string]$req.text
      if ($text.Length -gt 4000) { $text = $text.Substring(0, 4000) }
      $accepted = [AdionInput]::Text($text)
      $entered = $false
      if ($req.enter) { [AdionInput]::Chord([int[]]@(0x0D)); $entered = $true }
      Start-Sleep -Milliseconds 60
      $readback = Read-FocusedText
      $verified = $false
      if ($null -ne $readback -and $text.Trim().Length -gt 0) {
        $needle = ($text -replace '\s+', ' ').Trim()
        if ($needle.Length -gt 40) { $needle = $needle.Substring(0, 40) }
        $hay = ([string]$readback) -replace '\s+', ' '
        $verified = $hay.Contains($needle.Substring(0, [Math]::Min(8, $needle.Length)))
      }
      return @{ ok=($accepted -gt 0); accepted=$accepted; entered=$entered; verified=$verified;
                window=$target.window; focus=$target.focus; focusType=$target.focusType }
    }
    'keys.chord' {
      $vks = @($req.keys | ForEach-Object { [int]$_ })
      if ($vks.Count -lt 1 -or $vks.Count -gt 4) { return @{ ok=$false; error='1 to 4 keys' } }
      foreach ($v in $vks) { if ($PressVk -notcontains $v) { return @{ ok=$false; error=('key not allowed: ' + $v) } } }
      $target = Ensure-Target $req
      [AdionInput]::Chord([int[]]$vks)
      return @{ ok=$true; window=$target.window; focus=$target.focus }
    }
    'keys.press' {
      $vks = @($req.keys | ForEach-Object { [int]$_ })
      if ($vks.Count -lt 1 -or $vks.Count -gt 12) { return @{ ok=$false; error='1 to 12 keys' } }
      foreach ($v in $vks) { if ($PressVk -notcontains $v) { return @{ ok=$false; error=('key not allowed: ' + $v) } } }
      $target = Ensure-Target $req
      foreach ($v in $vks) { [AdionInput]::Chord([int[]]@($v)) }
      return @{ ok=$true; window=$target.window; focus=$target.focus }
    }
    'mouse.click' {
      $target = Ensure-Target $req
      if ($target.isPassword) { return @{ ok=$false; refused='password field'; window=$target.window } }
      $button = if ($req.button) { [string]$req.button } else { 'left' }
      $restore = if ($null -ne $req.restoreUser) { [bool]$req.restoreUser } else { $true }
      [AdionInput]::Click([int]$req.x, [int]$req.y, $button, [bool]$req.twice, [bool]$restore)
      return @{ ok=$true; x=[int]$req.x; y=[int]$req.y; window=$target.window }
    }
    'mouse.move' { [AdionInput]::Move([int]$req.x, [int]$req.y); return @{ ok=$true } }
    'mouse.scroll' {
      [AdionInput]::Scroll([int]$req.x, [int]$req.y, [int]$req.dy, [int]$req.dx)
      return @{ ok=$true }
    }
    'mouse.drag' {
      $steps = if ($req.steps) { [int]$req.steps } else { 12 }
      [AdionInput]::Drag([int]$req.x0, [int]$req.y0, [int]$req.x1, [int]$req.y1, $steps)
      return @{ ok=$true }
    }
    'win.activate' {
      if ($req.hwnd) {
        $h = [IntPtr][int64]$req.hwnd
        if (-not [AdionInput]::IsWindow($h)) { return @{ ok=$false; found=$false; error='no such window' } }
        $t = [AdionInput]::Title($h)
        $must = [string]$req.mustContain
        if ($must -and $must.Trim().Length -ge 2) {
          if (-not ([regex]::IsMatch($t, '(?i)(?:^|[^a-z0-9])' + [regex]::Escape($must.Trim()) + '(?![a-z0-9])'))) {
            return @{ ok=$false; found=$true; refused='title changed'; title=$t }
          }
        }
        $front = [AdionInput]::Activate($h)
        return @{ ok=[bool]$front; found=$true; title=$t; hwnd=[int64]$h }
      }
      $want = ([string]$req.name)
      if (-not $want -or $want.Trim().Length -lt 2) { return @{ ok=$false; error='name required' } }
      $norm = $want.ToLowerInvariant() -replace '[^a-z0-9]', ''
      $hit = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne $PID } | Where-Object {
        $p = $_.ProcessName.ToLowerInvariant() -replace '[^a-z0-9]', ''
        $t = ([string]$_.MainWindowTitle).ToLowerInvariant() -replace '[^a-z0-9]', ''
        ($p.Length -ge 2 -and ($norm.Contains($p) -or $p.Contains($norm))) -or $t.EndsWith($norm) -or $t.Contains($norm)
      } | Select-Object -First 1
      if (-not $hit) { return @{ ok=$false; found=$false } }
      $h = [IntPtr]$hit.MainWindowHandle
      $front = [AdionInput]::Activate($h)
      return @{ ok=[bool]$front; found=$true; title=[string]$hit.MainWindowTitle; hwnd=[int64]$h }
    }
    'focus.read' { return @{ text=(Read-FocusedText) } }
    default { return @{ error=('unknown op ' + $req.op) } }
  }
}

$stdin = [Console]::OpenStandardInput()
$reader = New-Object System.IO.StreamReader($stdin, [System.Text.Encoding]::UTF8)
Out-Line @{ ev='ready'; pid=$PID }
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -gt 0) {
    $id = $null
    try {
      $req = ConvertFrom-Json -InputObject $line
      $id = $req.id
      $res = Handle $req
      $res.id = $id
      Out-Line $res
    } catch {
      Out-Line @{ id=$id; error=[string]$_.Exception.Message }
    }
  }
}
