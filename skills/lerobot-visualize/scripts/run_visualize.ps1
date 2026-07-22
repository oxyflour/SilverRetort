[CmdletBinding(DefaultParameterSetName = "Serve")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Export")] [switch]$Export,
    [Parameter(Mandatory = $true, ParameterSetName = "Export")] [string]$Usd,
    [Parameter(Mandatory = $true, ParameterSetName = "Export")] [string]$Output,
    [Parameter(Mandatory = $true, ParameterSetName = "Serve")] [string]$Collision,
    [Parameter(ParameterSetName = "Serve")] [string]$RosRoot = "C:\Programs\ros2-windows",
    [Parameter(ParameterSetName = "Serve")] [string]$RosPython = $env:ROS_PYTHON,
    [Parameter(ParameterSetName = "Serve")] [string]$HostName = "127.0.0.1",
    [Parameter(ParameterSetName = "Serve")] [int]$Port = 8765
)

$ErrorActionPreference = "Stop"
$SkillRoot = Split-Path $PSScriptRoot -Parent
if ($PSCmdlet.ParameterSetName -eq "Export") {
    if (-not (Test-Path -LiteralPath $Usd -PathType Leaf)) { throw "USD not found: $Usd" }
    $Python = Join-Path $SkillRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
        throw "Exporter Python not found: $Python. Run 'uv sync' in $SkillRoot first"
    }
    & $Python (Join-Path $PSScriptRoot "export_collision.py") $Usd $Output
    exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $Collision -PathType Leaf)) { throw "Collision JSON not found: $Collision" }
$RosSetup = Join-Path $RosRoot "setup.bat"
if (-not (Test-Path -LiteralPath $RosSetup -PathType Leaf)) { throw "ROS setup not found: $RosSetup" }
if (-not $RosPython) {
    $RosPython = @(
        (Join-Path $RosRoot "python.exe"),
        (Join-Path $RosRoot ".pixi\envs\default\python.exe")
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $RosPython) { throw "Pass -RosPython or set ROS_PYTHON to a ROS-compatible Python" }
$PythonDir = Split-Path $RosPython -Parent
$env:PATH = "$PythonDir;$(Join-Path $PythonDir 'Library\bin');$(Join-Path $PythonDir 'Scripts');$env:PATH"
$SetupCommand = "set `"COLCON_PYTHON_EXECUTABLE=$RosPython`" && call `"$RosSetup`" && set"
$EnvironmentLines = & cmd.exe /d /s /c $SetupCommand
if ($LASTEXITCODE -ne 0) { throw "ROS setup failed with exit code $LASTEXITCODE" }
foreach ($Line in $EnvironmentLines) {
    $Separator = $Line.IndexOf("=")
    if ($Separator -gt 0) {
        [Environment]::SetEnvironmentVariable($Line.Substring(0, $Separator), $Line.Substring($Separator + 1), "Process")
    }
}
# Keep slash-prefixed ROS names here, never in a Git Bash command line.
$TfTopic = "/tf"
& $RosPython (Join-Path $PSScriptRoot "serve_visualizer.py") $Collision --host $HostName --port $Port --tf-topic $TfTopic
exit $LASTEXITCODE
