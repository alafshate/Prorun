# Installed only after opt-in. Persist ONLY documented subscription limit fields.
[Console]::InputEncoding = New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$raw = [Console]::In.ReadToEnd()
$OutputEncoding = New-Object Text.UTF8Encoding $false
try {
    $payload = $raw | ConvertFrom-Json
    $limits = @{}
    foreach ($key in @('five_hour', 'seven_day')) {
        $window = $payload.rate_limits.$key
        if ($null -ne $window -and $null -ne $window.used_percentage) {
            $limits[$key] = @{ used_percentage = $window.used_percentage; resets_at = $window.resets_at }
        }
    }
    $snapshot = @{ capturedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); rate_limits = $limits }
    $target = '__SNAPSHOT__'
    $temp = $target + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
    [IO.File]::WriteAllText($temp, ($snapshot | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding $false))
    if ([IO.File]::Exists($target)) { [IO.File]::Replace($temp, $target, $null) }
    else {
        try { [IO.File]::Move($temp, $target) }
        catch { [IO.File]::Replace($temp, $target, $null) }
    }
} catch { } # Capture failure must not break the user's status line.
finally {
    if ($temp -and [IO.File]::Exists($temp)) { try { [IO.File]::Delete($temp) } catch { } }
}
$previous = '__PREVIOUS__'
if ($previous) {
    $raw | & '__BASH__' --noprofile --norc -c $previous
} else {
    $parts = @()
    if ($null -ne $payload.rate_limits.five_hour.used_percentage) { $parts += ('5h: ' + $payload.rate_limits.five_hour.used_percentage + '%') }
    if ($null -ne $payload.rate_limits.seven_day.used_percentage) { $parts += ('Weekly: ' + $payload.rate_limits.seven_day.used_percentage + '%') }
    if ($parts.Count) { [Console]::WriteLine(($parts -join ' | ')) }
}
