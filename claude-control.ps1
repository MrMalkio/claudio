# Drives Claude desktop's Read aloud buttons through Windows UI Automation.
# Usage: claude-control.ps1 -Action windows|read|toggle [-Window "<window title>"]
# Prints one line of JSON.
#
# Safety: only buttons inside a reply's "Message actions" toolbar are ever pressed.
# Claude windows have other buttons with the same names (a session's own Stop
# button, for example), and pressing those would interrupt real work.
param(
  [Parameter(Mandatory = $true)][ValidateSet('windows', 'read', 'toggle')][string]$Action,
  [string]$Window = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$Invoke = [System.Windows.Automation.InvokePattern]::Pattern
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$buttonCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)

function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 4; exit 0 }

$pids = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
  Where-Object { $_.ExecutablePath -like '*\WindowsApps\Claude_*' } |
  ForEach-Object { [int]$_.ProcessId })
if ($pids.Count -eq 0) { Out-Json @{ ok = $false; error = 'Claude is not running' } }

$windows = @($A::RootElement.FindAll($Scope::Children, [System.Windows.Automation.Condition]::TrueCondition) |
  Where-Object { $pids -contains $_.Current.ProcessId })

# Read aloud buttons ("Read aloud", "Pause", "Resume") that sit in a reply's Message actions toolbar.
function Get-ReadButtons($w) {
  $b = $w.FindAll($Scope::Descendants, $buttonCond)
  # Chromium builds its accessibility tree lazily: the first query can come back nearly empty.
  if ($b.Count -le 3) { Start-Sleep -Milliseconds 400; $b = $w.FindAll($Scope::Descendants, $buttonCond) }
  @($b | Where-Object {
      $_.Current.Name -match '^(Read aloud|Pause|Resume)$' -and
      $Walker.GetParent($_).Current.Name -eq 'Message actions'
    })
}

# The thread (session) name: the page's document title, minus the app suffix.
# Falls back to the window title, which drops characters such as "&".
$docCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
function Get-Thread($w) {
  $name = ''
  foreach ($try in 1..2) {
    $d = $w.FindFirst($Scope::Descendants, $docCond)
    $name = if ($d) { $d.Current.Name -replace '\s+-\s+Claude( Code)?$', '' } else { '' }
    if (-not [string]::IsNullOrWhiteSpace($name)) { break }
    Start-Sleep -Milliseconds 300
  }
  if ([string]::IsNullOrWhiteSpace($name)) { $name = $w.Current.Name }
  return $name.Trim()
}

# The first sentence of the reply a Read aloud / Pause / Resume button belongs to.
# Claude labels each reply "Claude responded: <first sentence>": either on a "Message N"
# group just before the reply's content, or on a collapsed "Show message actions for ..." button.
function Get-Reply($button) {
  try {
    $node = $Walker.GetParent($button)  # the Message actions toolbar
    for ($i = 0; $i -lt 6; $i++) {
      $up = $Walker.GetParent($node)
      if (-not $up -or $up.Current.Name -eq 'Chat messages') { break }
      $node = $up
    }
    # Fallback when the label has scrolled out of the tree: the first line after the
    # reply's last unnamed group (usually a tool-call block), else the earliest line seen.
    $first = ''; $frozen = $false
    $s = $Walker.GetPreviousSibling($node)
    for ($i = 0; $s -and $i -lt 400; $i++) {
      $n = $s.Current.Name
      $t = $s.Current.ControlType
      if ($n -match '^(Show message actions for )?Claude responded:\s*(.+)$') { return $Matches[2].Trim() }
      if ($n -eq 'Load earlier messages' -or $n -like 'Use the up and down arrow keys*') { break }
      if ($t -eq [System.Windows.Automation.ControlType]::Group -and -not $n -and $first) { $frozen = $true }
      if ($t -eq [System.Windows.Automation.ControlType]::Group -and $n -match '^Message \d+$') {
        $c = $Walker.GetFirstChild($s)
        if ($c -and $c.Current.Name -match '^Claude responded:\s*(.+)$') { return $Matches[1].Trim() }
        break  # a user message: the reply started after it
      }
      if ($t -eq [System.Windows.Automation.ControlType]::ToolBar) { break }  # the previous reply's toolbar
      if (-not $frozen -and $t -eq [System.Windows.Automation.ControlType]::Text -and $n.Trim()) { $first = $n.Trim() }
      $s = $Walker.GetPreviousSibling($s)
    }
    return $first
  } catch { return '' }
}

switch ($Action) {
  'windows' {
    $list = foreach ($w in $windows) {
      $btns = @(Get-ReadButtons $w)
      $names = @($btns | ForEach-Object { $_.Current.Name })
      $active = $btns | Where-Object { $_.Current.Name -ne 'Read aloud' } | Select-Object -First 1
      $reads = @($names | Where-Object { $_ -eq 'Read aloud' }).Count
      $state = if ($names -contains 'Resume') { 'paused' } elseif ($names -contains 'Pause') { 'playing' } else { 'idle' }
      if ($reads -gt 0 -or $state -ne 'idle') { @{ title = $w.Current.Name; thread = (Get-Thread $w); readAloud = $reads; state = $state; reply = $(if ($active) { Get-Reply $active } else { '' }) } }
    }
    Out-Json @{ ok = $true; windows = @($list) }
  }
  'read' {
    $targets = if ($Window) { $windows | Where-Object { $_.Current.Name -eq $Window } } else { $windows }
    foreach ($w in $targets) {
      $b = Get-ReadButtons $w | Where-Object { $_.Current.Name -eq 'Read aloud' } | Select-Object -Last 1
      if ($b) { $b.GetCurrentPattern($Invoke).Invoke(); Out-Json @{ ok = $true; window = $w.Current.Name; thread = (Get-Thread $w); reply = (Get-Reply $b) } }
    }
    Out-Json @{ ok = $false; error = 'No Read aloud button found. Open a Claude reply first.' }
  }
  'toggle' {
    foreach ($w in $windows) {
      $b = Get-ReadButtons $w | Where-Object { $_.Current.Name -ne 'Read aloud' } | Select-Object -First 1
      if ($b) { $n = $b.Current.Name; $b.GetCurrentPattern($Invoke).Invoke(); Out-Json @{ ok = $true; did = $n; window = $w.Current.Name; thread = (Get-Thread $w); reply = (Get-Reply $b) } }
    }
    Out-Json @{ ok = $false; error = 'Claude is not reading aloud right now.' }
  }
}
