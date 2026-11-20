<#
.SYNOPSIS
  Deploy the Apps Script backend to one or all outlets (wrapper for npm run deploy).
.EXAMPLE
  .\tools\deploy.ps1 all     # every outlet in outlets.local.json
  .\tools\deploy.ps1 TS1     # only TS1
#>
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try { node scripts/deploy-apps-script.mjs @args } finally { Pop-Location }
exit $LASTEXITCODE
