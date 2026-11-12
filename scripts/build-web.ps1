#!/usr/bin/env pwsh
<#
.SYNOPSIS
Builds the browser package: the engine as WebAssembly (src/script and the Rhai apps compiled
into it) plus web/index.html and web/main.js. Serve web/ over HTTP and open it in a browser with
WebGPU (index.html?app=nebula-kingdom, or ?app=hello).

.DESCRIPTION
Needs: rustup target add wasm32-unknown-unknown, and wasm-bindgen-cli at the version in
Cargo.lock (cargo install wasm-bindgen-cli --version <it> --locked). With -Regenerate (or --regenerate)
it first re-translates Nebula Kingdom from its TypeScript (needs node and examples/studio-bundle's npm
install, for the TypeScript compiler).
#>

[CmdletBinding()]
param (
    [switch]$Regenerate,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Support both PowerShell-style (-Regenerate) and Bash-style (--regenerate) flags
$shouldRegenerate = $Regenerate.IsPresent -or ($RemainingArgs -contains '--regenerate')

Push-Location (Join-Path $PSScriptRoot '..')
try {
    if ($shouldRegenerate) {
        node scripts/ts2rhai.mjs examples/rhai/nebula_kingdom/ts2rhai.json
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    # Extract wasm-bindgen version from Cargo.lock
    $lockMatch = Select-String -Path 'Cargo.lock' -Pattern '^name = "wasm-bindgen"$' -Context 0, 1 | Select-Object -First 1
    $want = $null
    if ($lockMatch -and $lockMatch.Context.PostContext[0] -match '^version = "([^"]+)"$') {
        $want = $Matches[1]
    }

    # Check installed wasm-bindgen-cli version
    $have = $null
    if (Get-Command wasm-bindgen -ErrorAction SilentlyContinue) {
        $versionOutput = & wasm-bindgen --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $versionOutput) {
            $have = ($versionOutput -split '\s+')[1]
        }
    }

    if ($have -ne $want) {
        $foundText = if ($have) { $have } else { 'none' }
        [Console]::Error.WriteLine("wasm-bindgen-cli $want is needed (found $foundText): cargo install wasm-bindgen-cli --version $want --locked")
        exit 1
    }

    cargo rustc --lib --target wasm32-unknown-unknown --profile web --crate-type cdylib
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    wasm-bindgen --target web --no-typescript --out-dir web/pkg target/wasm32-unknown-unknown/web/entropy_engine.wasm
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if (Get-Command wasm-opt -ErrorAction SilentlyContinue) {
        wasm-opt -O2 --enable-bulk-memory --enable-nontrapping-float-to-int web/pkg/entropy_engine_bg.wasm -o web/pkg/entropy_engine_bg.wasm
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    Get-ChildItem -Force web/pkg
    Write-Host "Built web/. Serve it, e.g.: python -m http.server -d web 8080  ->  http://localhost:8080/?app=nebula-kingdom"
}
finally {
    Pop-Location
}