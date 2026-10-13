param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('start', 'status', 'stop')]
    [string]$Action,
    [switch]$Quiet,
    [switch]$Offline
)

$ErrorActionPreference = 'Stop'
$assistantRoot = Split-Path -Parent $PSScriptRoot
$assistantExitCode = 0

function Invoke-AssistantCli([string[]]$CliArgs) {
    $output = & $script:assistantNode (Join-Path $assistantRoot 'src\cli.js') @CliArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output -join "`n") }
    return ($output -join "`n")
}

function Get-AssistantState {
    $output = Invoke-AssistantCli @('status')
    if ($output.Trim().StartsWith('{')) { return ($output | ConvertFrom-Json) }
    return $null
}

function Format-AssistantState($State) {
    if (-not $State) { return "助手未运行。`n请双击「启动助手.vbs」。" }
    if ($State.mode -eq 'offline-test') { return '后台启动测试正在运行（不连接飞书和邮箱）。' }
    $connection = switch ($State.connection) {
        'connected' { '已连接' }
        'connecting' { '连接中' }
        'reconnecting' { '重连中' }
        'failed' { '连接失败，请检查配置和网络' }
        default { '正在准备连接' }
    }
    return "助手正在后台运行。`n飞书：$connection`n`n不需要保持终端或本提示窗口打开。`n电脑重启后，请再次双击「启动助手.vbs」。"
}

try {
    $assistantNode = (Get-Command node.exe -ErrorAction Stop).Source
    Set-Location -LiteralPath $assistantRoot
    if ($Action -eq 'start') {
        $cliArgs = @('start')
        if ($Offline) { $cliArgs += '--offline' }
        $null = Invoke-AssistantCli $cliArgs
        # Wait for the daemon's own status; successful process creation alone is insufficient.
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        do {
            $state = Get-AssistantState
            if ($state -and ($state.mode -eq 'offline-test' -or $state.connection -eq 'connected' -or $state.connection -eq 'failed')) { break }
            Start-Sleep -Milliseconds 500
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $state) { throw '助手没有成功启动。请查看 data\background.log 或运行 npm run doctor 检查配置。' }
        $message = Format-AssistantState $state
    } elseif ($Action -eq 'stop') {
        $null = Invoke-AssistantCli @('stop')
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            $state = Get-AssistantState
            if (-not $state) { break }
            Start-Sleep -Milliseconds 300
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($state) { throw '已请求停止，但后台进程尚未退出；稍后可双击“查看状态.vbs”核实。' }
        $message = '助手已停止。需要使用时，双击“启动助手.vbs”。'
    } else {
        $message = Format-AssistantState (Get-AssistantState)
    }
} catch {
    $assistantExitCode = 1
    $message = "操作未完成：`n$($_.Exception.Message)"
}

if ($Quiet) {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    Write-Output $message
} else {
    Add-Type -AssemblyName System.Windows.Forms
    $icon = if ($assistantExitCode -eq 0) { [System.Windows.Forms.MessageBoxIcon]::Information } else { [System.Windows.Forms.MessageBoxIcon]::Error }
    $null = [System.Windows.Forms.MessageBox]::Show($message, '个人助手', [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
}
exit $assistantExitCode
