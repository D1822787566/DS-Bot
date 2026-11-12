#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$DataRoot = (Join-Path $PSScriptRoot '.ds-bot-local'),
    [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath($PSScriptRoot)
$plugin = Join-Path $repo 'ds-bot'
$localVoice = Join-Path $repo 'local-voice'
$appDir = Join-Path $repo 'app'
if (-not [IO.Path]::IsPathRooted($DataRoot)) { $DataRoot = Join-Path $repo $DataRoot }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$node = (Get-Command node -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source

function Invoke-Npm {
    param([string]$Directory, [string[]]$Arguments)
    Push-Location $Directory
    try {
        & $npm @Arguments
        if ($LASTEXITCODE -ne 0) { throw "npm $($Arguments -join ' ') failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }
}

function Get-SourceHash {
    param([string[]]$Paths)
    [string[]]$normalized = @($Paths | ForEach-Object { [IO.Path]::GetFullPath($_).Replace('/', '\').ToLowerInvariant() })
    [Array]::Sort($normalized, [StringComparer]::Ordinal)
    $lines = foreach ($path in $normalized) {
        "$path $((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash)"
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join "`n")))).Replace('-', '')
    } finally { $sha.Dispose() }
}

function Install-IfChanged {
    param([string]$Directory, [string]$Hash, [string]$RequiredFile)
    $stamp = Join-Path $Directory 'node_modules/.source-launcher.sha256'
    if ((Test-Path -LiteralPath $RequiredFile) -and (Test-Path -LiteralPath $stamp) -and ([IO.File]::ReadAllText($stamp).Trim() -eq $Hash)) {
        Write-Host "Dependencies ready: $(Split-Path $Directory -Leaf)"
        return
    }
    Write-Host "Installing dependencies: $(Split-Path $Directory -Leaf)"
    Invoke-Npm $Directory @('ci', '--include=dev', '--no-fund', '--no-audit')
    if (-not (Test-Path -LiteralPath $RequiredFile)) { throw "Installation is incomplete: $RequiredFile" }
    [IO.File]::WriteAllText($stamp, $Hash)
}

function Sync-LocalPackageFiles {
    param([string]$Source, [string]$Target, $Package)
    $targetRoot = [IO.Path]::GetFullPath((Join-Path $appDir 'node_modules')) + [IO.Path]::DirectorySeparatorChar
    $Target = [IO.Path]::GetFullPath($Target)
    if (-not $Target.StartsWith($targetRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Package target is outside app/node_modules: $Target" }
    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
    [void][IO.Directory]::CreateDirectory($Target)
    foreach ($entry in @($Package.files)) {
        $sourcePath = Join-Path $Source $entry.path
        $targetPath = Join-Path $Target $entry.path
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $targetPath))
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
    }
}

$envNames = @('DS_BOT_HOME', 'DS_BOT_WORKSPACE', 'DS_BOT_SHELL_DATA', 'ELECTRON_RUN_AS_NODE')
$savedEnv = @{}
foreach ($name in $envNames) { $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    & $node --version
    if ($LASTEXITCODE -ne 0) { throw 'Node.js could not start.' }
    $pluginHash = Get-SourceHash @((Join-Path $plugin 'package.json'), (Join-Path $plugin 'package-lock.json'), (Join-Path $plugin '.npmrc'))
    Install-IfChanged $plugin $pluginHash (Join-Path $plugin 'node_modules/esbuild/package.json')
    Write-Host 'Building the plugin from this checkout...'
    Invoke-Npm $plugin @('run', 'build')

    # The desktop app installs a copy of the plugin. Hash npm's package file list so new
    # or removed source files also refresh that copy, even when its version is unchanged.
    $packJson = Invoke-Npm $plugin @('pack', '--dry-run', '--json', '--ignore-scripts')
    $package = @((($packJson -join "`n") | ConvertFrom-Json))[0]
    if (-not $package.files) { throw 'npm did not return the plugin package file list.' }
    $localVoiceJson = Invoke-Npm $localVoice @('pack', '--dry-run', '--json', '--ignore-scripts')
    $localVoicePackage = @((($localVoiceJson -join "`n") | ConvertFrom-Json))[0]
    if (-not $localVoicePackage.files) { throw 'npm did not return the Local Voice package file list.' }
    $appFiles = @((Join-Path $appDir 'package.json'), (Join-Path $appDir 'package-lock.json'), (Join-Path $appDir '.npmrc'))
    $appFiles += @($package.files | ForEach-Object { Join-Path $plugin $_.path })
    $appFiles += @($localVoicePackage.files | ForEach-Object { Join-Path $localVoice $_.path })
    $appHash = Get-SourceHash $appFiles
    Install-IfChanged $appDir $appHash (Join-Path $appDir 'node_modules/electron/package.json')
    # npm can reuse a cached file: dependency when the package version stays the
    # same. Refresh the installed DS Bot package from the exact file list above,
    # so the desktop Host never runs an older voice-runtime copy.
    Sync-LocalPackageFiles $plugin (Join-Path $appDir 'node_modules/ds-bot') $package
    Sync-LocalPackageFiles $localVoice (Join-Path $appDir 'node_modules/local-voice') $localVoicePackage

    $electron = Join-Path $appDir 'node_modules/electron/dist/electron.exe'
    if (-not (Test-Path -LiteralPath $electron)) {
        Write-Host 'Downloading the Electron runtime...'
        & $node (Join-Path $appDir 'node_modules/electron/install.js')
        if ($LASTEXITCODE -ne 0) { throw 'Electron download failed.' }
        if (-not (Test-Path -LiteralPath $electron)) { throw 'Electron executable is still missing.' }
    }

    $env:DS_BOT_HOME = Join-Path $DataRoot 'data'
    $env:DS_BOT_WORKSPACE = Join-Path $DataRoot 'workspace'
    $env:DS_BOT_SHELL_DATA = Join-Path $DataRoot 'shell'
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    foreach ($path in @($env:DS_BOT_HOME, $env:DS_BOT_WORKSPACE, $env:DS_BOT_SHELL_DATA)) {
        [void][IO.Directory]::CreateDirectory($path)
    }
    Write-Host "Persistent data: $DataRoot"
    if ($PrepareOnly) { Write-Host 'Ready. Run start.ps1 to open DS Bot.'; return }
    Write-Host 'Starting DS Bot. Configure model providers in Settings; close the window to stop.'
    Invoke-Npm $appDir @('start')
} finally {
    foreach ($name in $envNames) {
        if ($null -eq $savedEnv[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process') }
    }
}
