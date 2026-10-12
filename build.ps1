<#
.SYNOPSIS
  Build UpEnchant into a single .mcaddon (zipped behavior pack + resource pack).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath $PSScriptRoot
$base = (Get-Location).Path

$out = 'upenchant.mcaddon'
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }

# Validate JSON before packaging.
foreach ($path in 'BP/manifest.json', 'RP/manifest.json') {
    Get-Content -LiteralPath $path -Raw | ConvertFrom-Json | Out-Null
    Write-Host "ok: $path"
}

# .mcaddon is just a zip containing the pack folders at the top level.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$archive = [System.IO.Compression.ZipFile]::Open(
    (Join-Path $base $out),
    [System.IO.Compression.ZipArchiveMode]::Create
)
try {
    $entries = foreach ($pack in 'BP', 'RP') {
        Get-ChildItem -LiteralPath $pack -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($base.Length).TrimStart('\', '/')
            [pscustomobject]@{ File = $_.FullName; Name = ($rel -replace '\\', '/') }
        }
    }
    foreach ($entry in $entries | Sort-Object Name) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $entry.File, $entry.Name
        ) | Out-Null
    }
}
finally {
    $archive.Dispose()
}

Write-Host "built $out"
