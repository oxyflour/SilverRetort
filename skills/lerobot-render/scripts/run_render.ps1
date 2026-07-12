param(
    [Parameter(Mandatory = $true)] [string]$Usd,
    [string]$KitRoot = "C:\isaacsim-6",
    [string]$RosRoot = "C:\Programs\ros2-windows",
    [string]$RosPython = $env:ROS_PYTHON,
    [string]$Camera = "",
    [string]$SensorsFile = "",
    [int]$Width = 640,
    [int]$Height = 480,
    [double]$Fps = 20.0,
    [int]$Port = 39080,
    [string]$TfTopic = "/tf",
    [string]$ImageTopicPrefix = "/lerobot/render"
)

$ErrorActionPreference = "Stop"
$SkillRoot = Split-Path $PSScriptRoot -Parent
$RosSetup = Join-Path $RosRoot "setup.bat"
if (-not (Test-Path -LiteralPath $Usd -PathType Leaf)) { throw "USD not found: $Usd" }
if (-not (Test-Path -LiteralPath $RosSetup -PathType Leaf)) { throw "ROS setup not found: $RosSetup" }
if ($SensorsFile -and -not (Test-Path -LiteralPath $SensorsFile -PathType Leaf)) {
    throw "Sensors file not found: $SensorsFile"
}

$KitExe = Join-Path $KitRoot "kit\kit.exe"
if (-not (Test-Path -LiteralPath $KitExe -PathType Leaf)) {
    $KitExe = Get-ChildItem -LiteralPath $KitRoot -Filter "kit.exe" -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch "\\python\\" } |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $KitExe) { throw "kit.exe not found below: $KitRoot" }

if (-not $RosPython) {
    $Candidates = @(
        (Join-Path $RosRoot "python.exe"),
        (Join-Path $RosRoot ".pixi\envs\default\python.exe")
    )
    $RosPython = $Candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $RosPython) { throw "Pass -RosPython or set ROS_PYTHON to a ROS-compatible Python 3.10 executable" }

$PythonDir = Split-Path $RosPython -Parent
$env:PATH = "$PythonDir;$(Join-Path $PythonDir 'Library\bin');$env:PATH"
$SetupCommand = "set `"COLCON_PYTHON_EXECUTABLE=$RosPython`" && call `"$RosSetup`" && set"
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

$App = Join-Path $SkillRoot "apps\lerobot.render.app.kit"
$Exts = Join-Path $SkillRoot "exts"
$Arguments = @("`"$App`"", "--ext-folder", "`"$Exts`"")
foreach ($FolderName in @("exts", "extscache", "extsInternal", "extsDeprecated", "extsUser")) {
    $Folder = Join-Path $KitRoot $FolderName
    if (Test-Path -LiteralPath $Folder -PathType Container) {
        $Arguments += @("--ext-folder", "`"$Folder`"")
    }
}
$Arguments += @(
    "--/exts/lerobot/render/usd=`"$Usd`"",
    "--/exts/lerobot/render/camera=$Camera",
    "--/exts/lerobot/render/sensorsFile=`"$SensorsFile`"",
    "--/exts/lerobot/render/port=$Port",
    "--/exts/lerobot/render/width=$Width",
    "--/exts/lerobot/render/height=$Height"
)
$KitProcess = Start-Process -FilePath $KitExe -ArgumentList $Arguments -PassThru -WindowStyle Hidden
try {
    $Bridge = Join-Path $PSScriptRoot "ros_image_bridge.py"
    & $RosPython $Bridge --port $Port --fps $Fps --tf-topic $TfTopic --image-topic-prefix $ImageTopicPrefix
    exit $LASTEXITCODE
}
finally {
    if (-not $KitProcess.HasExited) { Stop-Process -Id $KitProcess.Id -Force }
}
