param([switch]$SkipRelease)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try {
    $buildFolder = Join-Path 'dist_new' ('build-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    python -m PyInstaller --noconfirm --distpath $buildFolder --workpath build 'BiliFav Studio.spec'
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
    if (-not $SkipRelease) {
        python tools/build_release.py --source (Join-Path $buildFolder 'BiliFav Studio')
        if ($LASTEXITCODE -ne 0) { throw 'Release packaging failed.' }
    }
} finally { Pop-Location }
