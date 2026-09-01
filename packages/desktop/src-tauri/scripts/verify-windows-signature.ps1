# Assert that the installer we are about to publish is really signed.
#
# The bundling step carries continue-on-error because NSIS is flaky on this
# runner. That flag once turned a failed signing pass into a passing job: the
# build errored with "failed to run powershell", the staging step copied the
# unsigned installer left by the --no-sign pass, and the artifact was published
# labelled as signed. Nothing reported it; only opening the file did.
#
# So check the property on the artifact that actually ships, rather than
# trusting the exit status of the step that was supposed to produce it.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Dest)

$ErrorActionPreference = 'Stop'

$signed = @(Get-ChildItem (Join-Path $Dest '*-setup.exe') -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike '*unsigned*' })
if ($signed.Count -eq 0) {
    throw "verify: no signed installer staged in $Dest"
}

foreach ($f in $signed) {
    $sig = Get-AuthenticodeSignature -LiteralPath $f.FullName
    Write-Host "verify: $($f.Name) -> $($sig.Status)"
    if ($sig.Status -ne 'Valid') {
        throw "verify: $($f.Name) is $($sig.Status), not Valid. The signing pass did not run or did not succeed, and publishing this would ship an unsigned installer as a signed one."
    }
    if (-not $sig.TimeStamperCertificate) {
        throw "verify: $($f.Name) carries no RFC 3161 timestamp, so its signature stops validating when the certificate expires."
    }
    if ($sig.SignerCertificate.Subject -notmatch 'Such Software LLC') {
        throw "verify: $($f.Name) signed by an unexpected certificate: $($sig.SignerCertificate.Subject)"
    }
}

# The unsigned copy must stay unsigned. If both are signed they are the same
# artifact under two names, and the reproducibility claim we publish is false.
foreach ($f in @(Get-ChildItem (Join-Path $Dest '*-setup-unsigned.exe') -ErrorAction SilentlyContinue)) {
    $sig = Get-AuthenticodeSignature -LiteralPath $f.FullName
    Write-Host "verify: $($f.Name) -> $($sig.Status) (expected NotSigned)"
    if ($sig.Status -eq 'Valid') {
        throw "verify: $($f.Name) is signed, but it is published as the unsigned build."
    }
}

Write-Host "verify: Windows artifacts are as labelled"
