param(
    [Parameter(Mandatory = $true)] [string]$Model,
    [Parameter(Mandatory = $true)] [string]$DatasetRoot,
    [string]$RepoId = "local/eval-simulation",
    [string]$RosRoot = "C:\Programs\ros2-windows",
    [string]$Python = "",
    [int]$Episodes = 10,
    [int]$Fps = 20,
    [double]$Duration = 10.0,
    [double]$ResetTime = 2.0,
    [double]$RandomRadius = 0.25,
    [string]$Goal = "",
    [double]$SuccessTolerance = 0.05,
    [string]$Task = "Move to the fixed target pose",
    [string]$Device = "auto",
    [int]$Seed = 0,
    [string]$Sensors = "auto",
    [string]$Namespace = "/lerobot",
    [string]$ImageTopicPrefix = "/lerobot/render",
    [switch]$StopOnSuccess,
    [switch]$UseVideos
)

$ErrorActionPreference = "Stop"
$SkillRoot = Split-Path $PSScriptRoot -Parent
$RosSetup = Join-Path $RosRoot "setup.bat"
if (-not (Test-Path -LiteralPath $RosSetup -PathType Leaf)) { throw "ROS setup not found: $RosSetup" }
if (Test-Path -LiteralPath $DatasetRoot) { throw "Dataset root already exists: $DatasetRoot" }
if (-not $Python) { $Python = Join-Path $SkillRoot ".venv\Scripts\python.exe" }
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw "Rollout Python not found: $Python. Run 'uv sync' in $SkillRoot first"
}

$PythonDir = Split-Path $Python -Parent
$RosRuntime = Join-Path $RosRoot ".pixi\envs\default"
$env:PATH = "$PythonDir;$env:PATH"
if (Test-Path -LiteralPath $RosRuntime -PathType Container) { $env:LEROBOT_ROS_RUNTIME = $RosRuntime }
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

$Script = Join-Path $PSScriptRoot "rollout_simulation.py"
$Arguments = @(
    $Script, "--model", $Model, "--root", $DatasetRoot, "--repo-id", $RepoId,
    "--episodes", $Episodes, "--fps", $Fps, "--duration", $Duration,
    "--reset-time", $ResetTime, "--random-radius", $RandomRadius,
    "--success-tolerance", $SuccessTolerance, "--task", $Task, "--device", $Device,
    "--seed", $Seed, "--sensors", $Sensors, "--namespace", $Namespace,
    "--image-topic-prefix", $ImageTopicPrefix
)
if ($Goal) { $Arguments += @("--goal", $Goal) }
if ($StopOnSuccess) { $Arguments += "--stop-on-success" }
if ($UseVideos) { $Arguments += "--use-videos" }
& $Python @Arguments
exit $LASTEXITCODE
