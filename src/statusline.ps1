# Glance statusLine — captures Claude's per-session status JSON (context window %,
# 5h/7d usage, cost) to ~/.claude/glance-status/<sessionId>.json, then CHAINS to the
# user's original statusLine so their line is preserved. Pure PowerShell for the
# capture (NO jq). Installed by Glance (opt-in; original backed up & restorable).
$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
$o = $null
try { $o = $raw | ConvertFrom-Json } catch { }

# --- capture (jq-free) ---
if ($o -and $o.session_id) {
  $dir = Join-Path $HOME '.claude/glance-status'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $out = [ordered]@{
    session_id     = $o.session_id
    model          = $o.model
    context_window = $o.context_window
    rate_limits    = $o.rate_limits
    cost           = $o.cost
    ts             = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  }
  $json = $out | ConvertTo-Json -Depth 8 -Compress
  [System.IO.File]::WriteAllText((Join-Path $dir ($o.session_id + '.json')), $json, (New-Object System.Text.UTF8Encoding($false)))
}

# --- chain: run the user's original statusLine (preserve their line) if one was saved ---
$printed = $false
$origFile = Join-Path $HOME '.claude/glance-orig-statusline'
if (Test-Path $origFile) {
  $orig = (Get-Content $origFile -Raw)
  if ($orig) { $orig = $orig.Trim() }
  if ($orig) {
    $bash = @(
      (Join-Path $env:ProgramFiles 'Git/bin/bash.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Git/bin/bash.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs/Git/bin/bash.exe')
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($bash) {
      try {
        $chained = $raw | & $bash -lc $orig 2>$null
        if ($null -ne $chained) { [Console]::Out.Write(($chained -join "`n")); $printed = $true }
      } catch { }
    }
  }
}

# --- fallback: Glance's own concise line (fresh users with no prior statusLine) ---
if (-not $printed -and $o) {
  $parts = @()
  if ($o.model.display_name) { $parts += [string]$o.model.display_name }
  if ($null -ne $o.context_window.used_percentage) { $parts += ('ctx %{0}' -f [math]::Round([double]$o.context_window.used_percentage)) }
  if ($o.cost.total_cost_usd) { $parts += ('${0:N2}' -f [double]$o.cost.total_cost_usd) }
  if ($null -ne $o.rate_limits.five_hour.used_percentage) { $parts += ('5s %{0}' -f [math]::Round([double]$o.rate_limits.five_hour.used_percentage)) }
  [Console]::Out.Write(($parts -join '  ·  '))
}
