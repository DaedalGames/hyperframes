# Probe only: what a test pass leaves on the runner. Dot-source, then call Measure-Runner "<label>" $stepStart.
function Measure-Runner([string]$Label, [datetime]$Since) {
  $temp = [IO.Path]::GetTempPath()
  $entries = @(Get-ChildItem $temp -Force -ErrorAction SilentlyContinue)
  $new = @($entries | Where-Object { $_.CreationTime -gt $Since })
  $bytes = (Get-ChildItem $temp -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  $os = Get-CimInstance Win32_OperatingSystem
  $procs = @(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -gt $Since -and $_.ProcessId -ne $PID })
  Write-Host ("=== measure {0} {1:o}: temp {2} entries ({3} new) {4} MB; free C {5} GB D {6} GB; free mem {7} MB; free virtual {8} MB; handles {9}; processes started since step {10}" -f `
    $Label, (Get-Date), $entries.Count, $new.Count, [int]($bytes / 1MB), [int]((Get-PSDrive C).Free / 1GB), [int]((Get-PSDrive D).Free / 1GB),
    [int]($os.FreePhysicalMemory / 1KB), [int]($os.FreeVirtualMemory / 1KB), (Get-Process | Measure-Object HandleCount -Sum).Sum, $procs.Count)
  $new | Group-Object { ($_.Name -replace '[0-9a-f]{8,}', '#' -replace '[-_.][0-9A-Za-z]{5,8}$', '-*') } |
    Sort-Object Count -Descending | Select-Object -First 15 | Format-Table Count, Name -AutoSize | Out-String -Width 200 | Write-Host
  $procs | Where-Object { $_.Name -match 'node|chrom|bun|ffm|ffp|powershell|pwsh|conhost' } |
    Select-Object ProcessId, ParentProcessId, Name, CreationDate, @{ n = 'CpuS'; e = { [int](($_.KernelModeTime + $_.UserModeTime) / 1e7) } },
      @{ n = 'Cmd'; e = { "$($_.CommandLine)".Substring(0, [Math]::Min(240, "$($_.CommandLine)".Length)) } } |
    Format-Table -AutoSize | Out-String -Width 400 | Write-Host
}
