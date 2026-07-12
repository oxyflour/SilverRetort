param(
    [Parameter(Mandatory = $true)] [string]$DatasetRoot,
    [string]$RepoId = "local/random-to-goal",
    [string]$RosRoot = "C:\Programs\ros2-windows",
    [string]$Python = "",
    [int]$Episodes = 10,
    [int]$Fps = 20,
    [double]$Duration = 3.0,
    [double]$ResetTime = 2.0,
    [double]$RandomRadius = 0.25,
    [string]$Goal = "",
    [int]$Seed = 0,
    [string]$Sensors = "auto",
    [string]$Namespace = "/lerobot",
    [string]$ImageTopicPrefix = "/lerobot/render",
    [switch]$UseVideos
)

$ErrorActionPreference = "Stop"
$SkillRoot = Split-Path $PSScriptRoot -Parent
$RosSetup = Join-Path $RosRoot "setup.bat"
if (-not (Test-Path -LiteralPath $RosSetup -PathType Leaf)) {
    throw "ROS setup not found: $RosSetup"
}
if (Test-Path -LiteralPath $DatasetRoot) {
    throw "Dataset root already exists; refusing to overwrite: $DatasetRoot"
}
if (-not $Python) {
    $Python = Join-Path $SkillRoot ".venv\Scripts\python.exe"
}
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw "Recorder Python not found: $Python. Run 'uv sync' in $SkillRoot first"
}

$PythonDir = Split-Path $Python -Parent
$RosRuntime = Join-Path $RosRoot ".pixi\envs\default"
$PathParts = @($PythonDir)
if (Test-Path -LiteralPath $RosRuntime -PathType Container) {
    $env:LEROBOT_ROS_RUNTIME = $RosRuntime
}
$env:PATH = (($PathParts + @($env:PATH)) -join ";")
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

$Script = Join-Path $PSScriptRoot "record_simulation.py"
$Arguments = @(
    $Script,
    "--root", $DatasetRoot,
    "--repo-id", $RepoId,
    "--episodes", $Episodes,
    "--fps", $Fps,
    "--duration", $Duration,
    "--reset-time", $ResetTime,
    "--random-radius", $RandomRadius,
    "--seed", $Seed,
    "--sensors", $Sensors,
    "--namespace", $Namespace,
    "--image-topic-prefix", $ImageTopicPrefix
)
if ($Goal) { $Arguments += @("--goal", $Goal) }
if ($UseVideos) { $Arguments += "--use-videos" }
& $Python @Arguments
exit $LASTEXITCODE
