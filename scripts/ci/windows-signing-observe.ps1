# Read task metadata only. This does not exercise the token or start the broker.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $tasks = @(Get-ScheduledTask -TaskPath '\' -TaskName 'SuchSoftwareSigningBroker' -ErrorAction Stop)
    if ($tasks.Count -ne 1 -or $tasks[0].TaskName -cne 'SuchSoftwareSigningBroker' -or $tasks[0].TaskPath -cne '\') {
        @{ status = 'unknown'; cause = 'identity-mismatch' } | ConvertTo-Json -Compress
    } else {
        @{ status = 'observed'; state = $tasks[0].State.ToString() } | ConvertTo-Json -Compress
    }
} catch {
    # Do not print task actions, command lines, or arbitrary provider messages.
    @{ status = 'unknown'; cause = 'query-failed'; errorCode = $_.Exception.HResult; category = $_.CategoryInfo.Category.ToString() } | ConvertTo-Json -Compress
}
