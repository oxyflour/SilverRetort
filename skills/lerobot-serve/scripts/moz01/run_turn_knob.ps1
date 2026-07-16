param(
    [Parameter(Mandatory = $true)] [string]$Scene,
    [Parameter(Mandatory = $true)] [string]$DatasetRoot,
    [string]$RepoId = "local/moz01-knob-turn",
    [string]$RosRoot = "C:\Programs\ros2-windows",
    [string]$Python = "",
    [int]$Episodes = 1,
    [string]$Sensors = "front,closeup",
    [int]$Width = 320,
    [int]$Height = 240,
    [double]$FrameTimeout = 180.0,
    [switch]$UseVideos
)

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
$ServeRoot = Split-Path (Split-Path $ScriptDir -Parent) -Parent
$RecordRoot = Join-Path (Split-Path $ServeRoot -Parent) "lerobot-record-simulation"
$Overlay = Join-Path $ServeRoot ".ros-overlay"
$RosSetup = Join-Path $RosRoot "setup.bat"

if (-not (Test-Path -LiteralPath $RosSetup -PathType Leaf)) { throw "ROS setup not found: $RosSetup" }
if (-not (Test-Path -LiteralPath $Scene -PathType Leaf)) { throw "Scene not found: $Scene" }
if (Test-Path -LiteralPath $DatasetRoot) { throw "Dataset root already exists; refusing to overwrite: $DatasetRoot" }
if (-not (Test-Path -LiteralPath (Join-Path $Overlay "ovphysx") -PathType Container)) {
    throw "ovphysx overlay missing: $Overlay (run lerobot-serve run_ros.ps1 once to create it)"
}

if (-not $Python) {
    $Python = Join-Path $RecordRoot ".venv\Scripts\python.exe"
}
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw "Recorder Python not found: $Python. Run 'uv sync' in $RecordRoot first"
}

$PythonDir = Split-Path $Python -Parent
$RosRuntime = Join-Path $RosRoot ".pixi\envs\default"
if (Test-Path -LiteralPath $RosRuntime -PathType Container) {
    $env:LEROBOT_ROS_RUNTIME = $RosRuntime
}
$env:LEROBOT_ROS_ROOT = $RosRoot
$env:PATH = "$PythonDir;$env:PATH"

$SetupCommand = "set `"COLCON_PYTHON_EXECUTABLE=$Python`" && call `"$RosSetup`" && set"
$EnvironmentLines = & cmd.exe /d /s /c $SetupCommand
if ($LASTEXITCODE -ne 0) { throw "ROS setup failed with exit code $LASTEXITCODE" }
foreach ($Line in $EnvironmentLines) {
    $Separator = $Line.IndexOf("=")
    if ($Separator -gt 0) {
        [Environment]::SetEnvironmentVariable(
            $Line.Substring(0, $Separator), $Line.Substring($Separator + 1), "Process"
        )
    }
}
# moz01 scripts + serve scripts (flat imports) + ovphysx overlay for the venv python
$env:PYTHONPATH = "$ScriptDir;$(Split-Path $ScriptDir -Parent);$Overlay;$env:PYTHONPATH"

$Script = Join-Path $ScriptDir "turn_knob_pipeline.py"
$Arguments = @(
    $Script,
    "--scene", $Scene,
    "--root", $DatasetRoot,
    "--repo-id", $RepoId,
    "--episodes", $Episodes,
    "--sensors", $Sensors,
    "--width", $Width,
    "--height", $Height,
    "--frame-timeout", $FrameTimeout
)
if ($UseVideos) { $Arguments += "--use-videos" }
& $Python @Arguments
exit $LASTEXITCODE
