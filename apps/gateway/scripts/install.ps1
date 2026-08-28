param(
  [string]$BaseUrl = "https://hized.app",
  [string]$SqlServer = "localhost",
  [int]$SqlPort = 1433,
  [Parameter(Mandatory = $true)][string]$Database,
  [ValidateSet("sql_server", "azure_sql")][string]$ConnectorType = "sql_server",
  [switch]$TrustServerCertificate,
  [string]$InstallDirectory = "$env:ProgramData\Hized\Gateway"
)

$ErrorActionPreference = "Stop"
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this installer from an elevated PowerShell window."
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$bundle = Join-Path $PSScriptRoot "index.js"
if (-not (Test-Path -LiteralPath $bundle)) { throw "index.js must be beside install.ps1." }

$enrollmentToken = Read-Host "Paste the 15-minute Hized enrolment token"
$sqlCredential = Get-Credential -Message "Enter the dedicated read-only SQL login"
$sqlPassword = $sqlCredential.GetNetworkCredential().Password
if ([string]::IsNullOrWhiteSpace($sqlPassword)) { throw "The SQL password cannot be empty." }

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
$installedBundle = Join-Path $InstallDirectory "index.js"
$configPath = Join-Path $InstallDirectory "gateway.config.json"

# Restrict the directory before writing either configuration or DPAPI-protected
# secrets. LocalMachine DPAPI is paired with this SYSTEM/Administrators ACL.
& icacls.exe $InstallDirectory /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not restrict the gateway directory ACL." }

# ncc can emit runtime chunks alongside index.js. Copy every JavaScript file so
# the installed bundle is complete rather than assuming it is a single file.
Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter "*.js" | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $InstallDirectory $_.Name) -Force
}
if (-not (Test-Path -LiteralPath $installedBundle)) { throw "The gateway runtime could not be installed." }

$config = [ordered]@{
  baseUrl = $BaseUrl
  installationId = [guid]::NewGuid().ToString()
  connectorType = $ConnectorType
  server = $SqlServer
  port = $SqlPort
  database = $Database
  encrypt = $true
  trustServerCertificate = [bool]$TrustServerCertificate
  pollIntervalSeconds = 5
}
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8

try {
  $env:HIZED_GATEWAY_ENROLMENT_TOKEN = $enrollmentToken
  $env:HIZED_GATEWAY_SQL_USERNAME = $sqlCredential.UserName
  $env:HIZED_GATEWAY_SQL_PASSWORD = $sqlPassword
  & $node $installedBundle enrol --config $configPath
  if ($LASTEXITCODE -ne 0) { throw "Gateway enrolment failed." }
} finally {
  Remove-Item Env:\HIZED_GATEWAY_ENROLMENT_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:\HIZED_GATEWAY_SQL_USERNAME -ErrorAction SilentlyContinue
  Remove-Item Env:\HIZED_GATEWAY_SQL_PASSWORD -ErrorAction SilentlyContinue
  $enrollmentToken = $null
  $sqlPassword = $null
  $sqlCredential = $null
}

$arguments = '"' + $installedBundle + '" run --config "' + $configPath + '"'
$action = New-ScheduledTaskAction -Execute $node -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -Description "Outbound-only Hized private SQL gateway"
Register-ScheduledTask -TaskName "Hized Private SQL Gateway" -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName "Hized Private SQL Gateway"

Write-Host "Hized gateway installed and started. No inbound firewall rule was created."
Write-Host "Run this health check from an elevated prompt:"
Write-Host ('  & "' + $node + '" "' + $installedBundle + '" test --config "' + $configPath + '"')
