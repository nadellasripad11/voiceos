# VoiceOS native bridge (Windows).
# Long-lived PowerShell host: reads one JSON request per line on stdin, writes
# one JSON response per line on stdout. Keeping the process alive avoids paying
# PowerShell's ~300ms startup cost on every keystroke injection.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$csharp = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class VOSNative {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);

    const int INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public int type; public INPUTUNION u; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint n, INPUT[] inputs, int size);

    static INPUT KeyInput(ushort vk, ushort scan, uint flags) {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk;
        i.u.ki.wScan = scan;
        i.u.ki.dwFlags = flags;
        i.u.ki.time = 0;
        i.u.ki.dwExtraInfo = IntPtr.Zero;
        return i;
    }

    // Presses every key in order, then releases in reverse order, so modifier
    // chords such as Ctrl+Shift+V arrive the way a human would type them.
    public static uint KeyCombo(ushort[] vks) {
        int n = vks.Length;
        INPUT[] inputs = new INPUT[n * 2];
        for (int k = 0; k < n; k++) inputs[k] = KeyInput(vks[k], 0, 0);
        for (int k = 0; k < n; k++) inputs[n + k] = KeyInput(vks[n - 1 - k], 0, KEYEVENTF_KEYUP);
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    // Press without releasing, so a chord can be held. Releasing is a separate
    // call, which is what makes hold-to-talk testable.
    public static uint KeyDown(ushort[] vks) {
        INPUT[] inputs = new INPUT[vks.Length];
        for (int k = 0; k < vks.Length; k++) inputs[k] = KeyInput(vks[k], 0, 0);
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static uint KeyUp(ushort[] vks) {
        INPUT[] inputs = new INPUT[vks.Length];
        for (int k = 0; k < vks.Length; k++) inputs[k] = KeyInput(vks[vks.Length - 1 - k], 0, KEYEVENTF_KEYUP);
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    // Unicode synthesis, one UTF-16 code unit at a time. Works in fields that
    // reject clipboard paste, and handles surrogate pairs (emoji) correctly
    // because each code unit is sent as its own event.
    public static uint TypeUnicode(string text) {
        INPUT[] inputs = new INPUT[text.Length * 2];
        for (int k = 0; k < text.Length; k++) {
            inputs[k * 2]     = KeyInput(0, text[k], KEYEVENTF_UNICODE);
            inputs[k * 2 + 1] = KeyInput(0, text[k], KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
        }
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static string WindowTitle(IntPtr h) {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }
    public static string WindowClass(IntPtr h) {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(h, sb, sb.Capacity);
        return sb.ToString();
    }
}
"@

if (-not ([System.Management.Automation.PSTypeName]'VOSNative').Type) {
    Add-Type -TypeDefinition $csharp
}

$VK = @{
  'ctrl' = 0x11; 'control' = 0x11; 'shift' = 0x10; 'alt' = 0x12; 'menu' = 0x12
  'win' = 0x5B; 'meta' = 0x5B; 'cmd' = 0x5B
  'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'escape' = 0x1B; 'esc' = 0x1B
  'space' = 0x20; 'backspace' = 0x08; 'delete' = 0x2E; 'home' = 0x24; 'end' = 0x23
  'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
  'pageup' = 0x21; 'pagedown' = 0x22; 'insert' = 0x2D
  'a' = 0x41; 'b' = 0x42; 'c' = 0x43; 'd' = 0x44; 'e' = 0x45; 'f' = 0x46; 'g' = 0x47
  'h' = 0x48; 'i' = 0x49; 'j' = 0x4A; 'k' = 0x4B; 'l' = 0x4C; 'm' = 0x4D; 'n' = 0x4E
  'o' = 0x4F; 'p' = 0x50; 'q' = 0x51; 'r' = 0x52; 's' = 0x53; 't' = 0x54; 'u' = 0x55
  'v' = 0x56; 'w' = 0x57; 'x' = 0x58; 'y' = 0x59; 'z' = 0x5A
  '0' = 0x30; '1' = 0x31; '2' = 0x32; '3' = 0x33; '4' = 0x34
  '5' = 0x35; '6' = 0x36; '7' = 0x37; '8' = 0x38; '9' = 0x39
  'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75
  'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
  # Media and volume keys. These are global: whichever player owns the media
  # session responds, so they work on Spotify, YouTube, VLC and so on without
  # any per-app API, token or paid plan.
  'media_play_pause' = 0xB3; 'media_next' = 0xB0; 'media_prev' = 0xB1
  'media_stop' = 0xB2; 'volume_mute' = 0xAD; 'volume_down' = 0xAE; 'volume_up' = 0xAF
  'browser_back' = 0xA6; 'browser_forward' = 0xA7; 'browser_refresh' = 0xA8
}

function Resolve-Combo([string]$combo) {
  $parts = $combo -split '\+' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ -ne '' }
  $vks = @()
  foreach ($p in $parts) {
    if (-not $VK.ContainsKey($p)) { throw "Unknown key '$p' in combo '$combo'" }
    $vks += [uint16]$VK[$p]
  }
  if ($vks.Count -eq 0) { throw 'Empty key combo' }
  return [uint16[]]$vks
}

function Get-ProcessNameFor($hwnd) {
  $procId = 0
  [void][VOSNative]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  try { return (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { return '' }
}

function Describe-Window($hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  # GA_ROOT = 2: climb from the child control to the real top-level window.
  $root = [VOSNative]::GetAncestor($hwnd, 2)
  if ($root -eq [IntPtr]::Zero) { $root = $hwnd }
  $r = New-Object VOSNative+RECT
  [void][VOSNative]::GetWindowRect($root, [ref]$r)
  return @{
    hwnd    = [int64]$root
    title   = [VOSNative]::WindowTitle($root)
    class   = [VOSNative]::WindowClass($root)
    process = Get-ProcessNameFor $root
    bounds  = @{ x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
  }
}

function Describe-Element($el, [switch]$WithText) {
  if ($null -eq $el) { return $null }
  try {
    $cur = $el.Current
    $info = @{
      name        = $cur.Name
      controlType = ($cur.ControlType.ProgrammaticName -replace '^ControlType\.', '')
      className   = $cur.ClassName
      isEnabled   = $cur.IsEnabled
      isPassword  = $cur.IsPassword
      bounds      = @{
        x = [int]$cur.BoundingRectangle.X; y = [int]$cur.BoundingRectangle.Y
        width = [int]$cur.BoundingRectangle.Width; height = [int]$cur.BoundingRectangle.Height
      }
    }
    # Never read the contents of a password field, even when asked to.
    if ($WithText -and -not $cur.IsPassword) {
      $vp = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
        $info['value'] = $vp.Current.Value
      } else {
        $tp = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
          $info['value'] = $tp.DocumentRange.GetText(4000)
          try {
            $info['selection'] = (($tp.GetSelection() | ForEach-Object { $_.GetText(4000) }) -join '')
          } catch {}
        }
      }
    }
    return $info
  } catch {
    return @{ error = $_.Exception.Message }
  }
}

# Windows.Media.Ocr and the media-session APIs are WinRT, which PowerShell 5.1
# can reach only once System.Runtime.WindowsRuntime is loaded. This is resolved
# lazily and cached: if WinRT is unavailable, OCR and media degrade to a clear
# error while text injection, UIA and screenshots keep working.
$script:AsTaskMethod = $null

function Get-AsTaskMethod() {
  if ($null -ne $script:AsTaskMethod) { return $script:AsTaskMethod }
  $wrt = [AppDomain]::CurrentDomain.GetAssemblies() |
    Where-Object { $_.GetName().Name -eq 'System.Runtime.WindowsRuntime' } | Select-Object -First 1
  if ($null -eq $wrt) {
    try { $wrt = [System.Reflection.Assembly]::Load('System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089') } catch {}
  }
  if ($null -eq $wrt) {
    try { Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
          $wrt = [AppDomain]::CurrentDomain.GetAssemblies() |
            Where-Object { $_.GetName().Name -eq 'System.Runtime.WindowsRuntime' } | Select-Object -First 1 } catch {}
  }
  $ext = if ($wrt) { $wrt.GetType('System.WindowsRuntimeSystemExtensions') } else { $null }
  if ($null -eq $ext) {
    throw 'WinRT interop is unavailable on this PowerShell host, so OCR and media control cannot run. Everything else still works.'
  }
  $script:AsTaskMethod = ($ext.GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  if ($null -eq $script:AsTaskMethod) { throw 'Could not resolve WindowsRuntimeSystemExtensions.AsTask' }
  return $script:AsTaskMethod
}

function Await-Async($op, $type) {
  $m = (Get-AsTaskMethod).MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  [void]$t.Wait(-1)
  return $t.Result
}

function Invoke-OcrFile([string]$path) {
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]

  $file    = Await-Async ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream  = Await-Async ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-Async ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap  = Await-Async ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine  = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { throw 'No OCR language pack is available on this system' }
  $result  = Await-Async ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $lines = @()
  foreach ($l in $result.Lines) { $lines += $l.Text }
  return @{ text = $result.Text; lines = $lines }
}

function Capture-Screen([string]$path, $region) {
  if ($region) {
    $bounds = New-Object System.Drawing.Rectangle([int]$region.x, [int]$region.y, [int]$region.width, [int]$region.height)
  } else {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  }
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return @{ path = $path; bounds = @{ x = $bounds.Left; y = $bounds.Top; width = $bounds.Width; height = $bounds.Height } }
}

# --- Media sessions -------------------------------------------------------
# GlobalSystemMediaTransportControlsSessionManager is the same mechanism behind
# the Windows volume flyout. It reads and controls whatever is playing (Spotify,
# a browser tab, VLC) with no app-specific API, OAuth token or paid tier.
function Get-MediaSessionManager() {
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  return Await-Async ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
    ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
}

function Select-MediaSession($manager, [string]$appHint) {
  if ([string]::IsNullOrWhiteSpace($appHint)) { return $manager.GetCurrentSession() }
  foreach ($s in $manager.GetSessions()) {
    if ($s.SourceAppUserModelId -like "*$appHint*") { return $s }
  }
  # Asked for a specific player that is not running: say so rather than
  # silently controlling whatever else happens to be playing.
  return $null
}

function Describe-MediaSession($session) {
  if ($null -eq $session) { return $null }
  $info = @{ app = $session.SourceAppUserModelId }
  try {
    $props = Await-Async ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $info['title']  = $props.Title
    $info['artist'] = $props.Artist
    $info['album']  = $props.AlbumTitle
    $info['trackNumber'] = $props.TrackNumber
  } catch {}
  try {
    $pb = $session.GetPlaybackInfo()
    $info['status'] = $pb.PlaybackStatus.ToString()
    if ($null -ne $pb.IsShuffleActive) { $info['shuffle'] = $pb.IsShuffleActive }
    $info['autoRepeatMode'] = if ($null -ne $pb.AutoRepeatMode) { $pb.AutoRepeatMode.ToString() } else { $null }
  } catch {}
  try {
    $tl = $session.GetTimelineProperties()
    $info['positionSeconds'] = [int]$tl.Position.TotalSeconds
    $info['durationSeconds'] = [int]$tl.EndTime.TotalSeconds
  } catch {}
  return $info
}

function Invoke-MediaAction($session, [string]$action, $value) {
  switch ($action) {
    'play'        { return Await-Async ($session.TryPlayAsync()) ([bool]) }
    'pause'       { return Await-Async ($session.TryPauseAsync()) ([bool]) }
    'toggle'      { return Await-Async ($session.TryTogglePlayPauseAsync()) ([bool]) }
    'next'        { return Await-Async ($session.TrySkipNextAsync()) ([bool]) }
    'previous'    { return Await-Async ($session.TrySkipPreviousAsync()) ([bool]) }
    'stop'        { return Await-Async ($session.TryStopAsync()) ([bool]) }
    'shuffle'     { return Await-Async ($session.TryChangeShuffleActiveAsync([bool]$value)) ([bool]) }
    'seek' {
      # Timeline positions are in 100-nanosecond ticks.
      $ticks = [int64]([double]$value * 10000000)
      return Await-Async ($session.TryChangePlaybackPositionAsync($ticks)) ([bool])
    }
    default { throw "Unknown media action '$action'" }
  }
}

# --- UI Automation actions -------------------------------------------------
function Find-UiaElement($root, [string]$name, [string]$controlType) {
  $conditions = @()
  if ($name) {
    $conditions += New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $name)
  }
  if ($controlType) {
    $ct = [System.Windows.Automation.ControlType]::($controlType)
    $conditions += New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)
  }
  if ($conditions.Count -eq 0) { throw 'Provide a name or controlType to search for' }
  $cond = if ($conditions.Count -eq 1) { $conditions[0] }
          else { New-Object System.Windows.Automation.AndCondition($conditions) }
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

function Invoke-UiaElement($el) {
  $ip = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
    $ip.Invoke(); return 'invoke'
  }
  $tp = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) {
    $tp.Toggle(); return 'toggle'
  }
  $sp = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) {
    $sp.Select(); return 'select'
  }
  $ep = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ep)) {
    $ep.Expand(); return 'expand'
  }
  throw 'Element exposes no invokable pattern'
}

function Get-UiaTree($el, [int]$depth, [int]$maxDepth, [int]$maxChildren) {
  $cur = $el.Current
  $node = @{
    name        = $cur.Name
    controlType = ($cur.ControlType.ProgrammaticName -replace '^ControlType\.', '')
  }
  $vp = $null
  if (-not $cur.IsPassword -and $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
    $node['value'] = $vp.Current.Value
  }
  if ($depth -lt $maxDepth) {
    $kids = @()
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $walker.GetFirstChild($el)
    $count = 0
    while ($null -ne $child -and $count -lt $maxChildren) {
      try { $kids += Get-UiaTree $child ($depth + 1) $maxDepth $maxChildren } catch {}
      $child = $walker.GetNextSibling($child)
      $count++
    }
    if ($kids.Count -gt 0) { $node['children'] = $kids }
  }
  return $node
}

function Set-Clip([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { [System.Windows.Forms.Clipboard]::Clear() }
  else { [System.Windows.Forms.Clipboard]::SetText($text) }
}

function Get-Clip() {
  if ([System.Windows.Forms.Clipboard]::ContainsText()) { return [System.Windows.Forms.Clipboard]::GetText() }
  return ''
}

function Get-IntOr($value, [int]$fallback) {
  if ($null -eq $value) { return $fallback }
  return [int]$value
}

function Invoke-BridgeCommand($req) {
  switch ($req.cmd) {
    'ping' { return @{ ok = $true; pong = $true; hostPid = $PID } }

    'getCursorPos' {
      $p = New-Object VOSNative+POINT
      [void][VOSNative]::GetCursorPos([ref]$p)
      return @{ ok = $true; x = $p.X; y = $p.Y }
    }

    'setCursorPos' {
      [void][VOSNative]::SetCursorPos([int]$req.x, [int]$req.y)
      return @{ ok = $true }
    }

    'getForeground' {
      return @{ ok = $true; window = (Describe-Window ([VOSNative]::GetForegroundWindow())) }
    }

    'getWindowAt' {
      $p = New-Object VOSNative+POINT
      $p.X = [int]$req.x; $p.Y = [int]$req.y
      return @{ ok = $true; window = (Describe-Window ([VOSNative]::WindowFromPoint($p))) }
    }

    'getFocusedElement' {
      $el = [System.Windows.Automation.AutomationElement]::FocusedElement
      return @{ ok = $true; element = (Describe-Element $el -WithText) }
    }

    'getElementAt' {
      $pt = New-Object System.Windows.Point([double]$req.x, [double]$req.y)
      $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
      return @{ ok = $true; element = (Describe-Element $el -WithText) }
    }

    'getClipboard' { return @{ ok = $true; text = (Get-Clip) } }

    'setClipboard' { Set-Clip $req.text; return @{ ok = $true } }

    'getSelection' {
      # Prefer UI Automation: it reads the selection without touching the
      # clipboard at all. Fall back to Ctrl+C only when the app exposes nothing.
      $el = [System.Windows.Automation.AutomationElement]::FocusedElement
      $tp = $null
      if ($el -and $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
        try {
          $sel = (($tp.GetSelection() | ForEach-Object { $_.GetText(20000) }) -join '')
          if ($sel -and $sel.Trim() -ne '') { return @{ ok = $true; text = $sel; via = 'uia' } }
        } catch {}
      }
      $saved = Get-Clip
      Set-Clip ''
      [void][VOSNative]::KeyCombo(@([uint16]0x11, [uint16]0x43))
      Start-Sleep -Milliseconds (Get-IntOr $req.waitMs 120)
      $got = Get-Clip
      if ($req.restoreClipboard -ne $false) { Set-Clip $saved }
      return @{ ok = $true; text = $got; via = 'clipboard' }
    }

    'insertText' {
      $mode = if ($req.mode) { $req.mode } else { 'paste' }
      if ($mode -eq 'type') {
        [void][VOSNative]::TypeUnicode([string]$req.text)
        return @{ ok = $true; via = 'type' }
      }
      $saved = Get-Clip
      Set-Clip ([string]$req.text)
      if ($mode -eq 'clipboard-only') { return @{ ok = $true; via = 'clipboard-only' } }
      # Let the clipboard settle before Ctrl+V, otherwise a fast target app can
      # read the previous contents.
      Start-Sleep -Milliseconds 60
      [void][VOSNative]::KeyCombo(@([uint16]0x11, [uint16]0x56))
      # Ctrl+V is asynchronous: the target app pulls from the clipboard on its
      # own message loop. Restoring too early makes it paste the OLD clipboard,
      # so wait generously, and scale the wait with payload size since large
      # pastes take longer to drain.
      $restoreWait = Get-IntOr $req.waitMs (350 + [Math]::Min(650, [int]([string]$req.text).Length / 4))
      Start-Sleep -Milliseconds $restoreWait
      if ($req.restoreClipboard -ne $false) { Set-Clip $saved }
      return @{ ok = $true; via = 'paste'; restoreWaitMs = $restoreWait }
    }

    'typeText' {
      [void][VOSNative]::TypeUnicode([string]$req.text)
      return @{ ok = $true }
    }

    'keys' {
      [void][VOSNative]::KeyCombo((Resolve-Combo $req.combo))
      return @{ ok = $true }
    }

    'keyDown' {
      [void][VOSNative]::KeyDown((Resolve-Combo $req.combo))
      return @{ ok = $true }
    }

    'keyUp' {
      [void][VOSNative]::KeyUp((Resolve-Combo $req.combo))
      return @{ ok = $true }
    }

    'focusWindow' {
      [void][VOSNative]::SetForegroundWindow([IntPtr][int64]$req.hwnd)
      return @{ ok = $true }
    }

    'screenshot' {
      $shot = Capture-Screen $req.path $req.region
      return @{ ok = $true; path = $shot.path; bounds = $shot.bounds }
    }

    'ocr' {
      $r = Invoke-OcrFile $req.path
      return @{ ok = $true; text = $r.text; lines = $r.lines }
    }

    'ocrScreen' {
      $shot = Capture-Screen $req.path $req.region
      $r = Invoke-OcrFile $req.path
      return @{ ok = $true; path = $shot.path; bounds = $shot.bounds; text = $r.text; lines = $r.lines }
    }

    # --- Launching apps, URLs and files ---
    'openUrl' {
      # Start-Process on a URL hands it to the user's default browser.
      Start-Process -FilePath ([string]$req.url) | Out-Null
      return @{ ok = $true; url = $req.url }
    }

    'openPath' {
      $target = [string]$req.path
      if (-not (Test-Path -LiteralPath $target)) { throw "Path not found: $target" }
      Start-Process -FilePath $target | Out-Null
      return @{ ok = $true; path = $target }
    }

    'startProcess' {
      $splat = @{ FilePath = [string]$req.file }
      if ($req.args) { $splat['ArgumentList'] = @($req.args) }
      if ($req.workingDirectory) { $splat['WorkingDirectory'] = [string]$req.workingDirectory }
      if ($req.hidden) { $splat['WindowStyle'] = 'Hidden' }
      $p = Start-Process @splat -PassThru
      return @{ ok = $true; processId = $p.Id; name = $p.ProcessName }
    }

    'openApp' {
      # Resolve in order of reliability: an explicit path, then a shell command
      # on PATH, then an AppsFolder entry (how Store/UWP apps are launched),
      # then a shell: URI.
      $name = [string]$req.name
      if (Test-Path -LiteralPath $name) {
        Start-Process -FilePath $name | Out-Null
        return @{ ok = $true; via = 'path'; name = $name }
      }
      $cmd = Get-Command $name -ErrorAction SilentlyContinue
      if ($cmd -and $cmd.CommandType -in @('Application', 'ExternalScript')) {
        Start-Process -FilePath $cmd.Source | Out-Null
        return @{ ok = $true; via = 'path-lookup'; name = $cmd.Source }
      }
      $shellApp = New-Object -ComObject Shell.Application
      $match = $shellApp.NameSpace('shell:AppsFolder').Items() |
        Where-Object { $_.Name -like "*$name*" } | Select-Object -First 1
      if ($match) {
        Start-Process ('shell:AppsFolder\' + $match.Path) | Out-Null
        return @{ ok = $true; via = 'appsfolder'; name = $match.Name }
      }
      throw "Could not find an app matching '$name'"
    }

    'listApps' {
      # Backs the agent's "which apps exist on this machine" lookup.
      $shellApp = New-Object -ComObject Shell.Application
      $items = $shellApp.NameSpace('shell:AppsFolder').Items() |
        ForEach-Object { @{ name = $_.Name; appId = $_.Path } }
      if ($req.filter) { $items = $items | Where-Object { $_.name -like ('*' + $req.filter + '*') } }
      return @{ ok = $true; apps = @($items | Select-Object -First (Get-IntOr $req.limit 200)) }
    }

    'listWindows' {
      $wins = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
        ForEach-Object {
          $r = New-Object VOSNative+RECT
          [void][VOSNative]::GetWindowRect($_.MainWindowHandle, [ref]$r)
          @{
            hwnd = [int64]$_.MainWindowHandle
            title = $_.MainWindowTitle
            process = $_.ProcessName
            bounds = @{ x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
          }
        }
      return @{ ok = $true; windows = @($wins) }
    }

    # --- Media ---
    'mediaStatus' {
      $mgr = Get-MediaSessionManager
      $sessions = @()
      foreach ($s in $mgr.GetSessions()) { $sessions += (Describe-MediaSession $s) }
      return @{ ok = $true; current = (Describe-MediaSession ($mgr.GetCurrentSession())); sessions = $sessions }
    }

    'mediaControl' {
      $mgr = Get-MediaSessionManager
      $session = Select-MediaSession $mgr ([string]$req.app)
      if ($null -eq $session) {
        return @{ ok = $false; error = if ($req.app) { "No media session found for '$($req.app)'. Is it running and playing?" }
                                      else { 'Nothing is currently playing' } }
      }
      $done = Invoke-MediaAction $session ([string]$req.action) $req.value
      Start-Sleep -Milliseconds 150
      return @{ ok = $true; accepted = $done; state = (Describe-MediaSession $session) }
    }

    'mediaKey' {
      # Fallback for players that do not register a media session.
      [void][VOSNative]::KeyCombo((Resolve-Combo $req.key))
      return @{ ok = $true }
    }

    # --- UI Automation actions ---
    'clickElement' {
      if ($req.x -ne $null -and $req.y -ne $null) {
        $pt = New-Object System.Windows.Point([double]$req.x, [double]$req.y)
        $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
      } else {
        $root = if ($req.hwnd) {
          [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$req.hwnd)
        } else {
          [System.Windows.Automation.AutomationElement]::FromHandle([VOSNative]::GetForegroundWindow())
        }
        $el = Find-UiaElement $root ([string]$req.name) ([string]$req.controlType)
      }
      if ($null -eq $el) { throw 'No matching element found' }
      $via = Invoke-UiaElement $el
      return @{ ok = $true; via = $via; element = (Describe-Element $el) }
    }

    'setElementValue' {
      $root = if ($req.hwnd) {
        [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$req.hwnd)
      } else {
        [System.Windows.Automation.AutomationElement]::FromHandle([VOSNative]::GetForegroundWindow())
      }
      $el = if ($req.name -or $req.controlType) {
        Find-UiaElement $root ([string]$req.name) ([string]$req.controlType)
      } else {
        [System.Windows.Automation.AutomationElement]::FocusedElement
      }
      if ($null -eq $el) { throw 'No matching element found' }
      if ($el.Current.IsPassword) { throw 'Refusing to write into a password field' }
      $vp = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
        throw 'Element does not support setting a value'
      }
      $vp.SetValue([string]$req.value)
      return @{ ok = $true }
    }

    'getUiTree' {
      $root = if ($req.hwnd) {
        [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$req.hwnd)
      } else {
        [System.Windows.Automation.AutomationElement]::FromHandle([VOSNative]::GetForegroundWindow())
      }
      if ($null -eq $root) { throw 'No window to read' }
      $tree = Get-UiaTree $root 0 (Get-IntOr $req.maxDepth 6) (Get-IntOr $req.maxChildren 40)
      return @{ ok = $true; tree = $tree }
    }

    default { return @{ ok = $false; error = ("Unknown command '" + $req.cmd + "'") } }
  }
}

# Handshake, so the Node side knows the bridge is live before sending work.
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $reqId = $null
  try {
    $req = $line | ConvertFrom-Json
    $reqId = $req.id
    $res = Invoke-BridgeCommand $req
  } catch {
    $res = @{ ok = $false; error = $_.Exception.Message }
  }
  if ($res -isnot [hashtable]) { $res = @{ ok = $true; value = $res } }
  $res['id'] = $reqId
  [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress -Depth 10))
  [Console]::Out.Flush()
}
