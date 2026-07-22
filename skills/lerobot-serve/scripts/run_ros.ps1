param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Usd,
    [string]$RosRoot = "C:\Programs\ros2-windows",
    [string]$RosPython = $env:ROS_PYTHON,
    [string]$Articulation = "/World/**",
    [string]$Namespace = "/lerobot",
    [double]$Fps = 60.0,
    [ValidateSet("cpu", "gpu")]
    [string]$Device = "cpu",
    [ValidateSet("", "moz01")]
    [string]$ControlProfile = "",
    [switch]$LockRoot,
    [switch]$Inspect,
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$SkillRoot = Split-Path $PSScriptRoot -Parent
$RosSetup = Join-Path $RosRoot "setup.bat"
$Overlay = Join-Path $SkillRoot ".ros-overlay"

if (-not (Test-Path -LiteralPath $RosSetup -PathType Leaf)) {
    throw "ROS setup script not found: $RosSetup"
}
if (-not (Test-Path -LiteralPath $Usd -PathType Leaf)) {
    throw "USD file not found: $Usd"
}

if (-not $RosPython) {
    $Candidates = @(
        (Join-Path $RosRoot "python.exe"),
        (Join-Path $RosRoot ".pixi\envs\default\python.exe")
    )
    $RosPython = $Candidates |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
}
if (-not $RosPython) {
    throw "No ROS Python found. Pass -RosPython or set ROS_PYTHON; the launcher will not install a runtime"
}

if (-not (Test-Path -LiteralPath (Join-Path $Overlay "ovphysx") -PathType Container)) {
    & uv pip install --python $RosPython --target $Overlay "numpy>=2.0,<3" "ovphysx>=0.4.13,<0.5"
    if ($LASTEXITCODE -ne 0) {
        throw "ovphysx overlay install failed with exit code $LASTEXITCODE"
    }
}

$PythonDir = Split-Path $RosPython -Parent
$env:PATH = "$PythonDir;$(Join-Path $PythonDir 'Library\bin');$(Join-Path $PythonDir 'Scripts');$env:PATH"

# setup.ps1 may be blocked by Windows execution policy. Capture the environment
# produced by the signed-independent batch entry point instead.
$SetupCommand = "set `"COLCON_PYTHON_EXECUTABLE=$RosPython`" && call `"$RosSetup`" && set"
$EnvironmentLines = & cmd.exe /d /s /c $SetupCommand
if ($LASTEXITCODE -ne 0) {
    throw "ROS setup failed with exit code $LASTEXITCODE"
}
foreach ($Line in $EnvironmentLines) {
    $Separator = $Line.IndexOf("=")
    if ($Separator -gt 0) {
        $Name = $Line.Substring(0, $Separator)
        $Value = $Line.Substring($Separator + 1)
        [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
    }
}
$env:PYTHONPATH = if ($env:PYTHONPATH) { "$Overlay;$env:PYTHONPATH" } else { $Overlay }

if ($CheckOnly) {
    & $RosPython -c "import rclpy, ovphysx, numpy; print('ROS/ovphysx imports OK'); print('ovphysx', ovphysx.__version__); print('numpy', numpy.__version__)"
    exit $LASTEXITCODE
}

$Serve = Join-Path $PSScriptRoot "serve.py"
$Arguments = @($Serve, $Usd, "--articulation", $Articulation, "--namespace", $Namespace, "--fps", $Fps, "--device", $Device)
if ($LockRoot) { $Arguments += "--lock-root" }
if ($Inspect) { $Arguments += "--inspect" }
if ($ControlProfile) { $Arguments += @("--control-profile", $ControlProfile) }
& $RosPython @Arguments
exit $LASTEXITCODE
