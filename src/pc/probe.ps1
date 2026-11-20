# Adion Browse — Windows read-only probe sidecar
#
# Adapted from nus-companion's win/probe.ps1 (Apache-2.0, potlakai/nus-companion
# v0.1.21), renamed and trimmed to the read-only surface Adion needs. The
# original's promise is kept: this process only ever READS the screen. It never
# presses a key or moves the mouse; src/pc/input.ps1 is the only process that
# does, and it is started separately.
#
# JSON lines in on stdin, JSON lines out on stdout.
#   {"id":1,"op":"ping"}
#   {"id":2,"op":"fg","ignorePid":123}                     foreground window
#   {"id":3,"op":"win.list","ignorePid":123}               open top-level windows
#   {"id":4,"op":"win.find","name":"notepad"}              is a window of this app open
#   {"id":5,"op":"uia.list","hwnd":123,"max":150}          interactive controls
#   {"id":6,"op":"uia.find","hwnd":123,"name":"Save"}      one control by name
#   {"id":7,"op":"uia.frompoint","x":100,"y":200}          control under a point
#   {"id":8,"op":"uia.focused"}                            control with keyboard focus
#   {"id":9,"op":"uia.text","hwnd":123,"max":200000}       the window's words
#   {"id":10,"op":"apps.list"}                             Start menu apps
#
# All coordinates are physical screen pixels (the process is per-monitor DPI
# aware). The Electron side converts with screen.screenToDipPoint.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AdionWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  public static string Title(IntPtr h) { var sb = new StringBuilder(1024); GetWindowTextW(h, sb, 1024); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
  public static int[] Rect(IntPtr h) { RECT r; if (!GetWindowRect(h, out r)) return null; return new int[] { r.L, r.T, r.R, r.B }; }
  // Top-level window under a point, skipping windows owned by ignorePid (our own).
  public static IntPtr TopWindowAt(int x, int y, uint ignorePid) {
    POINT p; p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    if (h == IntPtr.Zero) return h;
    h = GetAncestor(h, 2);
    int guard = 0;
    while (h != IntPtr.Zero && guard++ < 512) {
      if (IsWindowVisible(h) && Pid(h) != ignorePid) {
        RECT r;
        if (GetWindowRect(h, out r) && x >= r.L && x < r.R && y >= r.T && y < r.B) return h;
      }
      h = GetWindow(h, 2);
    }
    return IntPtr.Zero;
  }
}
"@

try { [void][AdionWin]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][AdionWin]::SetProcessDPIAware() } catch {} }

Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$cache = New-Object System.Windows.Automation.CacheRequest
$cache.Add($AE::NameProperty)
$cache.Add($AE::ControlTypeProperty)
$cache.Add($AE::AutomationIdProperty)
$cache.Add($AE::BoundingRectangleProperty)
$cache.Add($AE::IsOffscreenProperty)
$cache.Add($AE::ProcessIdProperty)
$cache.Add($AE::IsPasswordProperty)
$cache.TreeScope = [System.Windows.Automation.TreeScope]::Element

# Controls a person can act on. Containers are descended, not reported.
$Interactive = @{
  'Button'=1; 'MenuItem'=1; 'TabItem'=1; 'Hyperlink'=1; 'Edit'=1; 'ComboBox'=1;
  'CheckBox'=1; 'RadioButton'=1; 'ListItem'=1; 'TreeItem'=1; 'Slider'=1;
  'SplitButton'=1; 'Spinner'=1
}

function Out-Line($obj) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 6))
  [Console]::Out.Flush()
}

function Type-Name($el, $cached) {
  try {
    $ct = if ($cached) { $el.Cached.ControlType } else { $el.Current.ControlType }
    $n = $ct.ProgrammaticName
    if ($n -like 'ControlType.*') { return $n.Substring(12) }
    return $n
  } catch { return '' }
}

function Rect-Of($el, $cached) {
  try {
    $r = if ($cached) { $el.Cached.BoundingRectangle } else { $el.Current.BoundingRectangle }
    if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { return $null }
    if ([double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Y)) { return $null }
    return @{ x=[int][math]::Round($r.X); y=[int][math]::Round($r.Y); w=[int][math]::Round($r.Width); h=[int][math]::Round($r.Height) }
  } catch { return $null }
}

function Describe($el, $cached, $id) {
  $props = if ($cached) { $el.Cached } else { $el.Current }
  $name = ''; $auto = ''; $procId = 0; $pw = $false
  try { $name = [string]$props.Name } catch {}
  try { $auto = [string]$props.AutomationId } catch {}
  try { $procId = [int]$props.ProcessId } catch {}
  # A password box says so; the flag travels with the control and no value ever does.
  try { $pw = [bool]$props.IsPassword } catch {}
  return @{ id=$id; name=$name; type=(Type-Name $el $cached); automationId=$auto; rect=(Rect-Of $el $cached); pid=$procId; isPassword=$pw }
}

# The window the user is working in. When our own window is in front, walk down
# the z-order to the first visible, titled window that is not ours.
function Get-Foreground($ignore) {
  $h = [AdionWin]::GetForegroundWindow()
  $skipped = $false
  if ($ignore -and $h -ne [IntPtr]::Zero -and [AdionWin]::Pid($h) -eq [uint32]$ignore) {
    $skipped = $true
    $n = [AdionWin]::GetWindow($h, 2); $guard = 0
    while ($n -ne [IntPtr]::Zero -and $guard++ -lt 512) {
      if ([AdionWin]::IsWindowVisible($n) -and [AdionWin]::Pid($n) -ne [uint32]$ignore) {
        $t = [AdionWin]::Title($n)
        $rr = [AdionWin]::Rect($n)
        if ($t -and $t -ne 'Program Manager' -and $rr -and ($rr[2] - $rr[0]) -gt 120 -and ($rr[3] - $rr[1]) -gt 80) { $h = $n; break }
      }
      $n = [AdionWin]::GetWindow($n, 2)
    }
    if ($n -eq [IntPtr]::Zero -or $guard -ge 512) { $h = [IntPtr]::Zero }
  }
  if ($h -eq [IntPtr]::Zero) { return @{ hwnd=0; title=''; process=''; exe=''; pid=0; rect=$null; behindSelf=$skipped } }
  $procId = [AdionWin]::Pid($h)
  $proc = ''; $exe = ''
  try { $p = Get-Process -Id $procId -ErrorAction Stop; $proc = $p.ProcessName; try { $exe = $p.Path } catch {} } catch {}
  $r = [AdionWin]::Rect($h)
  $rect = $null
  if ($r) { $rect = @{ x=$r[0]; y=$r[1]; w=($r[2]-$r[0]); h=($r[3]-$r[1]) } }
  return @{ hwnd=[int64]$h; title=[AdionWin]::Title($h); process=$proc; exe=$exe; pid=[int]$procId; rect=$rect; behindSelf=$skipped }
}

# Depth-first walk of the control view under a window, bounded by count, depth
# and time. Returns interactive, on-screen elements in document order.
function Walk-Controls($hwnd, $max, $budgetMs) {
  $root = $AE::FromHandle([IntPtr][int64]$hwnd)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $out = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $truncated = $false
  $first = $null
  try { $first = $walker.GetFirstChild($root, $cache) } catch { $first = $null }
  if ($first) { $stack.Push(@($first, 1)) }
  $seen = 0
  while ($stack.Count -gt 0) {
    if ($out.Count -ge $max -or $sw.ElapsedMilliseconds -gt $budgetMs) { $truncated = $true; break }
    $item = $stack.Pop(); $el = $item[0]; $depth = $item[1]
    $seen++
    $sib = $null
    try { $sib = $walker.GetNextSibling($el, $cache) } catch { $sib = $null }
    if ($sib) { $stack.Push(@($sib, $depth)) }
    $off = $false
    try { $off = [bool]$el.Cached.IsOffscreen } catch {}
    $type = Type-Name $el $true
    if (-not $off -and $Interactive.ContainsKey($type) -and $Interactive[$type] -eq 1) {
      $d = Describe $el $true ($out.Count + 1)
      if ($d.rect) { [void]$out.Add($d) }
    }
    if ($depth -lt 18 -and -not $off) {
      $child = $null
      try { $child = $walker.GetFirstChild($el, $cache) } catch { $child = $null }
      if ($child) { $stack.Push(@($child, $depth + 1)) }
    }
  }
  return @{ elements=@($out.ToArray()); truncated=$truncated; visited=$seen; ms=[int]$sw.ElapsedMilliseconds }
}

function Score-Name($candidate, $want) {
  if (-not $candidate) { return 0 }
  $c = $candidate.Trim().ToLowerInvariant(); $w = $want.Trim().ToLowerInvariant()
  
  # Phonetic/acoustic variant map (Whisper STT "base" -> "bass", etc.)
  function Get-Variant($tok) {
    $map = @{
      'base' = @('base','bass')
      'bass' = @('bass','base')
      'db' = @('db','decibel','decibels')
      'decibel' = @('decibel','decibels','db')
      'decibels' = @('decibels','decibel','db')
      'vad' = @('vad','voice')
      'freq' = @('freq','frequency')
      'boost' = @('boost','gain')
    }
    if ($map.ContainsKey($tok)) { return $map[$tok] }
    return @($tok)
  }
  
  # Tokenize and score each token with phonetic variants
  $cTokens = $c -split '[\s\-_\.]+' | Where-Object { $_.Length -gt 1 }
  $wTokens = $w -split '[\s\-_\.]+' | Where-Object { $_.Length -gt 1 }
  if (($cTokens.Count -eq 0) -or ($wTokens.Count -eq 0)) { return 0 }
  
  $matches = 0
  foreach ($wt in $wTokens) {
    $vMatches = Get-Variant $wt
    foreach ($ct in $cTokens) {
      if ($ct -eq $wt) { $matches++; continue }
      foreach ($v in $vMatches) {
        if ($ct -eq $v) { $matches++; continue }
        if ($ct.Length -ge 4 -and $v.Length -ge 4 -and ($ct.Contains($v) -or $v.Contains($ct))) { $matches++; continue }
      }
    }
  }
  $score = [math]::Round($matches / $wTokens.Count * 80)
  
  if ($c -eq $w) { return [math]::Max($score, 100) }
  if ($c.StartsWith($w)) { return [math]::Max($score, 80) }
  if ($c.Contains($w)) { return [math]::Max($score, 60) }
  if ($w.Contains($c) -and $c.Length -ge 3) { return [math]::Max($score, 40) }
  if ($score -gt 0) { return $score }
  return 0
}

# The words of a window, for "summarize this" and "read me the document".
# Password fields are never read. Capped at max characters and budgetMs.
$textCache = New-Object System.Windows.Automation.CacheRequest
$textCache.Add($AE::NameProperty)
$textCache.Add($AE::ControlTypeProperty)
$textCache.Add($AE::IsPasswordProperty)
$textCache.Add($AE::ProcessIdProperty)
$textCache.Add($AE::IsTextPatternAvailableProperty)
$textCache.TreeScope = [System.Windows.Automation.TreeScope]::Element
function Get-WindowText($hwnd, [int]$max, [int]$budgetMs, $ignore) {
  $root = $AE::FromHandle([IntPtr][int64]$hwnd)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $docs = New-Object System.Text.StringBuilder
  $names = New-Object System.Text.StringBuilder
  $stack = New-Object System.Collections.Stack
  $sources = 0; $skipped = 0; $truncated = $false
  try { $rootEl = $root.GetUpdatedCache($textCache); $stack.Push(@($rootEl, 0, $true)) } catch {}
  while ($stack.Count -gt 0) {
    if ($sw.ElapsedMilliseconds -gt $budgetMs) { $truncated = $true; break }
    if (($docs.Length + $names.Length) -ge $max) { $truncated = $true; break }
    $item = $stack.Pop(); $el = $item[0]; $depth = $item[1]; $isRoot = $item[2]
    if (-not $isRoot) {
      $sib = $null
      try { $sib = $walker.GetNextSibling($el, $textCache) } catch { $sib = $null }
      if ($sib) { $stack.Push(@($sib, $depth, $false)) }
    }
    $pw = $false; $proc = 0
    try { $pw = [bool]$el.Cached.IsPassword } catch {}
    try { $proc = [int]$el.Cached.ProcessId } catch {}
    if ($pw) { $skipped++; continue }
    if ($ignore -and $proc -eq [int]$ignore) { continue }
    $hasText = $false
    try { $hasText = [bool]$el.GetCachedPropertyValue($AE::IsTextPatternAvailableProperty) } catch { $hasText = $false }
    if ($hasText) {
      try {
        $pat = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        $left = $max - $docs.Length
        if ($left -gt 0) {
          $t = [string]$pat.DocumentRange.GetText($left)
          if ($t.Trim().Length -gt 0) { if ($docs.Length -gt 0) { [void]$docs.Append("`n`n") }; [void]$docs.Append($t); $sources++ }
        }
        continue
      } catch {}
    }
    if ((Type-Name $el $true) -eq 'Text') {
      $n = ''
      try { $n = [string]$el.Cached.Name } catch {}
      if ($n.Trim().Length -gt 0 -and $names.Length -lt $max) { [void]$names.Append($n.Trim()); [void]$names.Append("`n") }
    }
    if ($depth -lt 30) {
      $child = $null
      try { $child = $walker.GetFirstChild($el, $textCache) } catch { $child = $null }
      if ($child) { $stack.Push(@($child, ($depth + 1), $false)) }
    }
  }
  $text = if ($docs.Length -gt 0) { $docs.ToString() } else { $names.ToString() }
  if ($text.Length -gt $max) { $text = $text.Substring(0, $max); $truncated = $true }
  return @{ text=$text; from=$(if ($docs.Length -gt 0) { 'document' } else { 'labels' }); sources=$sources; passwordsSkipped=$skipped; truncated=$truncated; ms=[int]$sw.ElapsedMilliseconds; hwnd=[int64]$hwnd; title=[AdionWin]::Title([IntPtr][int64]$hwnd) }
}

function Handle($req) {
  $op = [string]$req.op
  switch ($op) {
    'ping' { return @{ ok=$true; pid=$PID; ps=$PSVersionTable.PSVersion.ToString() } }
    'fg' { $ig = if ($req.ignorePid) { [uint32]$req.ignorePid } else { 0 }; return Get-Foreground $ig }
    'cursor' { $c = [AdionWin]::Cursor(); return @{ x=$c[0]; y=$c[1] } }
    'uia.list' {
      $max = if ($req.max) { [int]$req.max } else { 150 }
      $budget = if ($req.budgetMs) { [int]$req.budgetMs } else { 1200 }
      $hwnd = if ($req.hwnd) { [int64]$req.hwnd } else { [int64][AdionWin]::GetForegroundWindow() }
      $r = Walk-Controls $hwnd $max $budget
      $r.hwnd = $hwnd
      return $r
    }
    'uia.frompoint' {
      $x = [int][double]$req.x; $y = [int][double]$req.y
      $ignore = if ($req.ignorePid) { [uint32]$req.ignorePid } else { [uint32]0 }
      $h = [AdionWin]::TopWindowAt($x, $y, $ignore)
      if ($h -eq [IntPtr]::Zero) { return @{ element=$null; hwnd=0 } }
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $best = $null
      try {
        $pt = New-Object System.Windows.Point ([double]$x), ([double]$y)
        $el = $AE::FromPoint($pt)
        $depth = 0
        while ($el -and $depth -lt 8) {
          $t = Type-Name $el $false
          $procId = 0; try { $procId = [int]$el.Current.ProcessId } catch {}
          if ($procId -eq $ignore -and $ignore -ne 0) { $el = $null; break }
          if ($Interactive.ContainsKey($t) -and $Interactive[$t] -eq 1) { break }
          if ($t -eq 'Window') { $el = $null; break }
          $el = $walker.GetParent($el)
          $depth++
        }
        if ($el) { $d = Describe $el $false 0; if ($d.rect -and $d.pid -ne $ignore -and ([double]$d.rect.w * [double]$d.rect.h) -lt 240000) { $best = $d } }
      } catch {}
      if ($best) { return @{ element=$best; hwnd=[int64]$h; window=@{ title=[AdionWin]::Title($h); pid=[int][AdionWin]::Pid($h) }; ms=[int]$sw.ElapsedMilliseconds } }
      $left = [Math]::Max(150, 900 - [int]$sw.ElapsedMilliseconds)
      $r = Walk-Controls ([int64]$h) 400 $left
      $bestArea = [double]::MaxValue
      foreach ($e in $r.elements) {
        $rc = $e.rect
        if ($rc -and $x -ge $rc.x -and $x -lt ($rc.x + $rc.w) -and $y -ge $rc.y -and $y -lt ($rc.y + $rc.h)) {
          $area = [double]$rc.w * [double]$rc.h
          if ($area -lt $bestArea) { $best = $e; $bestArea = $area }
        }
      }
      return @{ element=$best; hwnd=[int64]$h; window=@{ title=[AdionWin]::Title($h); pid=[int][AdionWin]::Pid($h) }; searched=$r.elements.Count }
    }
    'uia.focused' {
      $ignore = if ($req.ignorePid) { [uint32]$req.ignorePid } else { [uint32]0 }
      try {
        $f = $AE::FocusedElement
        if (-not $f) { return @{ element=$null } }
        $d = Describe $f $false 0
        if ($ignore -ne 0 -and $d.pid -eq $ignore) { return @{ element=$null; ours=$true } }
        $pw = $false; try { $pw = [bool]$f.Current.IsPassword } catch {}
        $autoId = ''; try { $autoId = [string]$f.Current.AutomationId } catch {}
        $cls = ''; try { $cls = [string]$f.Current.ClassName } catch {}
        return @{ element=@{ name=$d.name; type=$d.type; rect=$d.rect; isPassword=$pw; pid=$d.pid; autoId=$autoId; className=$cls } }
      } catch { return @{ element=$null; error=[string]$_.Exception.Message } }
    }
    'uia.text' {
      $hwnd = if ($req.hwnd) { [int64]$req.hwnd } else { [int64][AdionWin]::GetForegroundWindow() }
      $max = if ($req.max) { [Math]::Max(1000, [Math]::Min(400000, [int]$req.max)) } else { 200000 }
      $budget = if ($req.budgetMs) { [Math]::Max(200, [Math]::Min(8000, [int]$req.budgetMs)) } else { 2500 }
      $ig = if ($req.ignorePid) { [int]$req.ignorePid } else { 0 }
      return Get-WindowText $hwnd $max $budget $ig
    }
    'uia.find' {
      $hwnd = if ($req.hwnd) { [int64]$req.hwnd } else { [int64][AdionWin]::GetForegroundWindow() }
      $want = [string]$req.name
      $type = [string]$req.type
      $r = Walk-Controls $hwnd 400 1500
      $best = $null; $bestScore = 0
      foreach ($e in $r.elements) {
        $s = Score-Name $e.name $want
        if ($s -gt 0 -and $type -and $e.type -eq $type) { $s += 15 }
        if ($s -gt $bestScore) { $best = $e; $bestScore = $s }
      }
      return @{ element=$best; score=$bestScore; searched=$r.elements.Count; truncated=$r.truncated }
    }
    'apps.list' {
      $apps = @(Get-StartApps | ForEach-Object { @{ name=[string]$_.Name; appId=[string]$_.AppID } })
      return @{ apps=$apps }
    }
    'win.find' {
      $want = ([string]$req.name).ToLowerInvariant() -replace '[^a-z0-9]', ''
      if ($want.Length -lt 2) { return @{ found=$false; error='name too short' } }

      # 1. Check visible top-level windows first (most reliable for real HWNDs across Electron, UWP, WPF)
      $n = [AdionWin]::GetWindow([AdionWin]::GetForegroundWindow(), 0); $guard = 0
      while ($n -ne [IntPtr]::Zero -and $guard++ -lt 256) {
        if ([AdionWin]::IsWindowVisible($n)) {
          $wp = [AdionWin]::Pid($n)
          $t = [AdionWin]::Title($n)
          $rr = [AdionWin]::Rect($n)
          if ($wp -ne $PID -and $t -and $t -ne 'Program Manager' -and $rr -and ($rr[2] - $rr[0]) -gt 80) {
            $pName = ''
            try { $pName = (Get-Process -Id $wp -ErrorAction SilentlyContinue).ProcessName } catch {}
            $normP = $pName.ToLowerInvariant() -replace '[^a-z0-9]', ''
            $normT = $t.ToLowerInvariant() -replace '[^a-z0-9]', ''
            if (($normP.Length -ge 2 -and ($want.Contains($normP) -or $normP.Contains($want))) -or ($normT.Length -ge 2 -and ($normT.Contains($want) -or $want.Contains($normT)))) {
              return @{ found=$true; process=$pName; title=$t; hwnd=[int64]$n }
            }
          }
        }
        $n = [AdionWin]::GetWindow($n, 2)
      }

      # 2. Process search with non-zero MainWindowHandle
      $hit = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne $PID } | Where-Object {
        $p = $_.ProcessName.ToLowerInvariant() -replace '[^a-z0-9]', ''
        $t = ([string]$_.MainWindowTitle).ToLowerInvariant() -replace '[^a-z0-9]', ''
        ($p.Length -ge 2 -and ($want.Contains($p) -or $p.Contains($want))) -or $t.EndsWith($want) -or $t.Contains($want)
      } | Select-Object -First 1
      if ($hit) {
        return @{ found=$true; process=$hit.ProcessName; title=[string]$hit.MainWindowTitle; hwnd=[int64]$hit.MainWindowHandle }
      }
      # Fallback: check UWP / Store apps where MainWindowHandle may be 0
      $uwpProc = Get-Process | Where-Object { $_.Id -ne $PID } | Where-Object {
        $p = $_.ProcessName.ToLowerInvariant() -replace '[^a-z0-9]', ''
        $p.Length -ge 2 -and ($want.Contains($p) -or $p.Contains($want))
      } | Select-Object -First 1
      if ($uwpProc) {
        return @{ found=$true; process=$uwpProc.ProcessName; title=$uwpProc.ProcessName; hwnd=0 }
      }
      return @{ found=$false }
    }
    'win.list' {
      $ig = if ($req.ignorePid) { [uint32]$req.ignorePid } else { 0 }
      $out = New-Object System.Collections.ArrayList
      $names = @{}
      $n = [AdionWin]::GetWindow([AdionWin]::GetForegroundWindow(), 0); $guard = 0
      while ($n -ne [IntPtr]::Zero -and $guard++ -lt 512 -and $out.Count -lt 64) {
        if ([AdionWin]::IsWindowVisible($n)) {
          $wp = [AdionWin]::Pid($n)
          $t = [AdionWin]::Title($n)
          $rr = [AdionWin]::Rect($n)
          if ($wp -ne $ig -and $t -and $t -ne 'Program Manager' -and $rr -and $rr[0] -gt -30000 -and ($rr[2] - $rr[0]) -gt 120 -and ($rr[3] - $rr[1]) -gt 80) {
            if (-not $names.ContainsKey($wp)) { try { $names[$wp] = (Get-Process -Id $wp -ErrorAction Stop).ProcessName } catch { $names[$wp] = '' } }
            [void]$out.Add(@{ hwnd=[int64]$n; title=$t; process=$names[$wp]; pid=[int]$wp; rect=@{ x=$rr[0]; y=$rr[1]; w=($rr[2]-$rr[0]); h=($rr[3]-$rr[1]) } })
          }
        }
        $n = [AdionWin]::GetWindow($n, 2)
      }
      return @{ windows=$out.ToArray() }
    }
    default { return @{ error=('unknown op ' + $op) } }
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
