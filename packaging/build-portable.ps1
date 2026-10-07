param(
    [string]$Configuration = "Release",
    [string]$NodeVersion = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $root "package.json") | ConvertFrom-Json
$icon = Join-Path $root "assets\copilot.ico"
if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) {
    throw "Copilot icon asset not found: $icon"
}
$artifacts = Join-Path $root "artifacts"
$staging = Join-Path $artifacts "copilot-changelog-win-x64"
$temp = Join-Path $artifacts ".tmp"

if (-not $NodeVersion) {
    $NodeVersion = (Get-Content -LiteralPath (Join-Path $root ".node-version") -Raw).Trim()
}
if ($NodeVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "NodeVersion must be a semantic version such as 24.21.0."
}

Remove-Item $staging, $temp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $staging, $temp | Out-Null

Push-Location $root
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed." }

    $app = Join-Path $staging "app"
    $application = Join-Path $app "node_modules\copilot-changelog-cli"
    New-Item -ItemType Directory -Force -Path $application | Out-Null
    foreach ($entry in @("package.json", "package-lock.json", "dist", "assets", "README.md")) {
        Copy-Item -LiteralPath (Join-Path $root $entry) -Destination $application -Recurse
    }
    & npm ci --omit=dev --no-audit --no-fund --prefix $application
    if ($LASTEXITCODE -ne 0) { throw "Production dependency installation failed." }

    $nodeArchive = Join-Path $temp "node.zip"
    $nodeUri = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
    Invoke-WebRequest -UseBasicParsing -Uri $nodeUri -OutFile $nodeArchive
    $nodeExtract = Join-Path $temp "node"
    Expand-Archive $nodeArchive -DestinationPath $nodeExtract
    $nodeRoot = Get-ChildItem $nodeExtract -Directory | Select-Object -First 1
    $runtime = Join-Path $staging "runtime"
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    Copy-Item (Join-Path $nodeRoot.FullName "node.exe") $runtime
    Copy-Item (Join-Path $nodeRoot.FullName "LICENSE") (Join-Path $runtime "NODE-LICENSE.txt")

    $compiler = @(
        "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
        "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $compiler) { throw "The Windows C# compiler was not found." }
    & $compiler /nologo /optimize+ /target:exe /win32icon:"$icon" /out:"$(Join-Path $staging 'copilot-changelog.exe')" "$(Join-Path $PSScriptRoot 'launcher\Program.cs')"
    if ($LASTEXITCODE -ne 0) { throw "Windows launcher compilation failed." }

    Push-Location $application
    $previousUpdateCheck = $env:COPILOT_CHANGELOG_SKIP_UPDATE_CHECK
    try {
        & (Join-Path $runtime "node.exe") --input-type=module -e "await import('@github/copilot-win32-x64/sdk'); await import('@github/copilot-sdk')"
        if ($LASTEXITCODE -ne 0) { throw "The packaged GitHub Copilot SDK could not be resolved." }
        $env:COPILOT_CHANGELOG_SKIP_UPDATE_CHECK = "1"
        $actualVersion = (& (Join-Path $staging "copilot-changelog.exe") --version).Trim()
        if ($LASTEXITCODE -ne 0) { throw "The packaged Windows launcher failed its smoke test." }
        if ($actualVersion -ne $package.version) {
            throw "Packaged CLI version $actualVersion does not match manifest version $($package.version)."
        }
    }
    finally {
        $env:COPILOT_CHANGELOG_SKIP_UPDATE_CHECK = $previousUpdateCheck
        Pop-Location
    }

    Copy-Item (Join-Path $root "README.md") $staging
    $zip = Join-Path $artifacts "copilot-changelog-$($package.version)-win-x64.zip"
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    $portableContents = @(
        $app,
        $runtime,
        (Join-Path $staging "copilot-changelog.exe"),
        (Join-Path $staging "README.md")
    )
    Compress-Archive -Path $portableContents -DestinationPath $zip
    Write-Host "Portable application: $staging"
    Write-Host "Portable archive: $zip"
}
finally {
    Pop-Location
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
