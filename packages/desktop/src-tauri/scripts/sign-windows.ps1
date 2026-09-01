# Hand one PE file to the signing broker and wait for it to come back signed.
#
# Invoked by Tauri through bundle.windows.signCommand, once per binary it needs
# signed: the application executable before packaging, and the NSIS installer
# after it is built. Both matter. An unsigned installer wrapping a signed
# executable still shows an unknown publisher at the moment the user decides
# whether to trust it, and a signed installer that drops an unsigned executable
# moves the same warning to first launch.
#
# The private key is non-exportable and lives on a SafeNet eToken, so nothing
# here ever sees it. This process writes a file into the broker's queue and
# waits; the broker signs as the operator whose session has the token logged in.
# See ~/src/docs/platform/windows-hardware-token-signing.md.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
    throw "sign-windows: nothing to sign at $Path"
}

# The breaker is tripped by any broker failure and cleared only by a human. One
# loud failure is worth more than a pile of confusing ones, so stop here rather
# than queue work that will not be served.
if (Test-Path 'C:\signing\SIGNING_LOCKED') {
    Get-Content 'C:\signing\SIGNING_LOCKED'
    throw "sign-windows: the broker's circuit breaker is tripped; an operator must clear it."
}

# The queue is shared with every other app on this host, so the name has to be
# unique. Collide and two builds race over one output file.
$runId  = if ($env:GITHUB_RUN_ID) { $env:GITHUB_RUN_ID } else { [guid]::NewGuid().ToString('N') }
$leaf   = Split-Path -Leaf $Path
$queued = "smirk-$runId-$([guid]::NewGuid().ToString('N').Substring(0,8))-$leaf"
$inPath = "C:\signing\in\$queued"
$outPath = "C:\signing\out\$queued"

Write-Host "sign-windows: queueing $leaf as $queued"
Copy-Item -LiteralPath $Path -Destination $inPath -Force
# The .ready marker is written last, so the broker never sees a half-copied file.
Set-Content -LiteralPath "$inPath.ready" -Value $runId

$deadline = (Get-Date).AddMinutes(10)
while ((Get-Date) -lt $deadline) {
    if (Test-Path "$outPath.done") { break }
    if (Test-Path 'C:\signing\SIGNING_LOCKED') {
        throw "sign-windows: the broker tripped while signing $leaf."
    }
    Start-Sleep -Seconds 5
}
if (-not (Test-Path "$outPath.done")) {
    throw "sign-windows: timed out after 10 minutes waiting for the broker on $leaf."
}

Move-Item -LiteralPath $outPath -Destination $Path -Force

# Verify what actually ships, not an intermediate copy. A bad signature or a
# missing timestamp must fail the build: a signature that expires with the
# certificate, rather than being pinned by a timestamp, silently stops
# validating the day the certificate does.
$sig = Get-AuthenticodeSignature -LiteralPath $Path
if ($sig.Status -ne 'Valid') {
    throw "sign-windows: Authenticode status is $($sig.Status) for $leaf"
}
if (-not $sig.TimeStamperCertificate) {
    throw "sign-windows: no RFC 3161 timestamp on $leaf"
}
if ($sig.SignerCertificate.Subject -notmatch 'Such Software LLC') {
    throw "sign-windows: unexpected signer for $leaf : $($sig.SignerCertificate.Subject)"
}

Write-Host "sign-windows: signed $leaf ($($sig.SignerCertificate.Subject))"
