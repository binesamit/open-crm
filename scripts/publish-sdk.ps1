# Publishes the extension developer kit to the public npm registry:
#   @bines/ext-sdk     - the SDK for extension pages and servers   (npm install @bines/ext-sdk)
#   create-bines-app   - the project generator                     (npx create-bines-app my-extension)
# Both are MIT and are published together, with the same version line (create-bines-app's SDK_VERSION = the SDK's).
#
# One-time setup on npmjs.com:
#   - The "@bines" scope must belong to you: npmjs.com -> your avatar -> Add Organization -> name "bines" (free plan,
#     public packages). If "bines" is taken, change the scope in the package names (packages/ext-sdk, packages/create-bines-app and their READMEs).
#   - Verify your email on npmjs.com.
#
# Easiest way (recommended):
#   1. npm login            (opens the browser; sign in to npmjs.com, approve)
#   2. powershell -ExecutionPolicy Bypass -File "<repo>\scripts\publish-sdk.ps1"          -> dry run (nothing published)
#   3. powershell -ExecutionPolicy Bypass -File "<repo>\scripts\publish-sdk.ps1" -Real    -> publish
#      If npm asks for a one-time code (2FA), run with -Otp 123456 (the code from your authenticator app).
#      A code is valid ~30 seconds and both packages use it - if the second one fails with EOTP, run again with a
#      new code: a version that is already on npm is skipped.
#
# Alternative: a granular access token (npmjs.com -> Access Tokens -> Generate New Token -> Granular Access Token,
#   Packages and scopes: "Read and write", All packages, and tick "Bypass two-factor authentication" if offered):
#   $env:NPM_TOKEN = '<token>'   then run step 3. The token is used only for this run and never saved.
#
# Only one of them: -Only sdk   or   -Only app
# A new version later: raise "version" in packages/ext-sdk/package.json (and SDK_VERSION in
# packages/create-bines-app/scaffold.mjs - a test checks they match) and/or packages/create-bines-app/package.json.
param([switch]$Real, [string]$Otp = '', [ValidateSet('all', 'sdk', 'app')][string]$Only = 'all')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $repo 'packages\ext-sdk\package.json'))) { throw "Not the Bines repository: $repo" }
$out = Join-Path ([System.IO.Path]::GetTempPath()) ('bines-npm-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $out | Out-Null
$npmrc = Join-Path $out '.npmrc.publish'
Push-Location $repo
try {
  $cfg = @()
  if ($env:NPM_TOKEN) {
    "//registry.npmjs.org/:_authToken=$($env:NPM_TOKEN)" | Out-File -FilePath $npmrc -Encoding ascii
    $cfg = @('--userconfig', $npmrc)
  }
  # 1) Who am I on npm? (fails if not logged in / token invalid)
  $who = (& npm whoami @cfg 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $who) {
    Write-Host ''
    Write-Host 'npm does not know who you are, so it cannot publish.' -ForegroundColor Yellow
    Write-Host 'Fix: run  npm login  (sign in in the browser), then run this script again.' -ForegroundColor Yellow
    Write-Host 'Or set $env:NPM_TOKEN to a GRANULAR token with "Read and write" on packages (classic Automation tokens no longer work).' -ForegroundColor Yellow
    exit 1
  }
  Write-Host "npm user: $who"

  # 2) Install, test, build.
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
  if ($Only -ne 'app') {
    pnpm --filter '@bines/ext-sdk' test
    if ($LASTEXITCODE -ne 0) { throw 'SDK tests failed - nothing was published' }
    pnpm --filter '@bines/ext-sdk' run build:npm
    if ($LASTEXITCODE -ne 0) { throw 'SDK build failed - nothing was published' }
  }
  if ($Only -ne 'sdk') {
    pnpm --filter 'create-bines-app' test
    if ($LASTEXITCODE -ne 0) { throw 'create-bines-app tests failed - nothing was published' }
  }

  # 3) Pack with pnpm (it applies publishConfig: the SDK's package.json points at dist/ instead of src/) and
  #    publish each tarball with npm (2FA / token as above). The SDK first: create-bines-app depends on it.
  $packages = @()
  if ($Only -ne 'app') { $packages += @{ dir = 'packages\ext-sdk'; name = '@bines/ext-sdk' } }
  if ($Only -ne 'sdk') { $packages += @{ dir = 'packages\create-bines-app'; name = 'create-bines-app' } }
  foreach ($p in $packages) {
    $version = (Get-Content (Join-Path $repo "$($p.dir)\package.json") -Raw | ConvertFrom-Json).version
    # Not on npm yet = npm prints E404 on stderr (not an error here).
    $existing = $null
    try { $existing = (& npm view "$($p.name)@$version" version @cfg 2>$null) } catch { $existing = $null }
    if ($existing -eq $version) {
      Write-Host "$($p.name)@$version is already on npm - skipped (raise the version to publish again)." -ForegroundColor Cyan
      continue
    }
    Push-Location (Join-Path $repo $p.dir)
    try {
      $before = @(Get-ChildItem $out -Filter '*.tgz' | ForEach-Object { $_.FullName })
      pnpm pack --pack-destination $out
      if ($LASTEXITCODE -ne 0) { throw "pnpm pack failed for $($p.name)" }
    } finally { Pop-Location }
    $tgz = Get-ChildItem $out -Filter '*.tgz' | Where-Object { $before -notcontains $_.FullName } | Select-Object -First 1
    if (-not $tgz) { throw "No package file was made for $($p.name)" }
    Write-Host "`n=== $($p.name)@$version  ($($tgz.Name))" -ForegroundColor Green
    & tar -tzf $tgz.FullName
    $args2 = @('publish', $tgz.FullName, '--access', 'public') + $cfg
    if ($Otp) { $args2 += @('--otp', $Otp) }
    if (-not $Real) {
      & npm @args2 --dry-run
      continue
    }
    & npm @args2
    if ($LASTEXITCODE -ne 0) {
      Write-Host ''
      Write-Host "Publishing $($p.name) FAILED." -ForegroundColor Red
      Write-Host '- E404 / E403 "permission" on @bines/...: the "bines" organization on npmjs.com is missing or is not yours, or the token cannot write.' -ForegroundColor Yellow
      Write-Host '- EOTP / "one-time password": run again with  -Otp <6-digit code>  (a fresh one). Published versions are skipped.' -ForegroundColor Yellow
      Write-Host '- "email not verified": verify your email on npmjs.com first.' -ForegroundColor Yellow
      exit 1
    }
    Write-Host "Published $($p.name)@$version as $who." -ForegroundColor Green
  }
  if (-not $Real) {
    Write-Host "`nDRY RUN - nothing published. Run again with -Real to publish."
  } else {
    Write-Host "`nDone. Try it:  npx create-bines-app my-extension   (it depends on @bines/ext-sdk from npm)"
  }
} finally {
  Pop-Location
  if (Test-Path $out) { Remove-Item $out -Recurse -Force }
  $sdkDist = Join-Path $repo 'packages\ext-sdk\dist'
  if (Test-Path $sdkDist) { Remove-Item $sdkDist -Recurse -Force }
}
