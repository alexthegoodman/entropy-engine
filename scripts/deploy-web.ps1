#!/usr/bin/env pwsh
<#
.SYNOPSIS
Builds the browser package and deploys web/ to Vercel as a static site.

.DESCRIPTION
One-time setup: npm i -g vercel, then `vercel login` and, from entropy-engine/web, `vercel link`
(framework "Other", no build command, output directory ".").
Pass -Preview to deploy a preview URL instead of production, -SkipBuild to reuse web/pkg,
-Regenerate to re-translate Nebula Kingdom from TypeScript first.
#>

[CmdletBinding()]
param (
    [switch]$Preview,
    [switch]$SkipBuild,
    [switch]$Regenerate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Push-Location (Join-Path $PSScriptRoot '..')
try {
    if (-not (Get-Command vercel -ErrorAction SilentlyContinue)) {
        [Console]::Error.WriteLine("vercel CLI not found: npm i -g vercel")
        exit 1
    }

    if (-not $SkipBuild) {
        if ($Regenerate) { & "$PSScriptRoot/build-web.ps1" -Regenerate } else { & "$PSScriptRoot/build-web.ps1" }
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    if (-not (Test-Path 'web/pkg/entropy_engine_bg.wasm')) {
        [Console]::Error.WriteLine("web/pkg is missing: run without -SkipBuild")
        exit 1
    }

    # Run from web/ so its own vercel.json and .vercel link apply, and the repo .gitignore
    # (which excludes web/pkg) does not strip the build output from the upload.
    Push-Location web
    try {
        if ($Preview) { vercel deploy } else { vercel deploy --prod }
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally {
        Pop-Location
    }
}
finally {
    Pop-Location
}
