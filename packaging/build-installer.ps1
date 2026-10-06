param([string]$IsccPath = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $root "package.json") | ConvertFrom-Json

& (Join-Path $PSScriptRoot "build-portable.ps1")
if ($LASTEXITCODE -ne 0) { throw "Portable build failed." }

if (-not $IsccPath) {
    $IsccPath = @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $IsccPath) {
    throw "Inno Setup 6 is required. Install it with: winget install --id JRSoftware.InnoSetup --exact"
}

$source = Join-Path $root "artifacts\copilot-changelog-win-x64"
& $IsccPath "/DAppVersion=$($package.version)" "/DSourceDir=$source" (Join-Path $PSScriptRoot "copilot-changelog.iss")
if ($LASTEXITCODE -ne 0) { throw "Installer compilation failed." }
Write-Host "Installer created in $(Join-Path $root 'artifacts')."
