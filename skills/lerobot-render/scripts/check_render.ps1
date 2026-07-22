param(
    [string]$RosRoot = "C:\Programs\ros2-windows",
    [string]$Sensor = "front"
)
$ErrorActionPreference = "Stop"
$RosSetup = Join-Path $RosRoot "setup.bat"
if (-not (Test-Path -LiteralPath $RosSetup -PathType Leaf)) { throw "ROS setup not found: $RosSetup" }
$EnvironmentLines = & cmd.exe /d /s /c "call `"$RosSetup`" && set"
if ($LASTEXITCODE -ne 0) { throw "ROS setup failed with exit code $LASTEXITCODE" }
foreach ($Line in $EnvironmentLines) {
    $Separator = $Line.IndexOf("=")
    if ($Separator -gt 0) {
        [Environment]::SetEnvironmentVariable($Line.Substring(0, $Separator), $Line.Substring($Separator + 1), "Process")
    }
}
# Slash-prefixed ROS names are deliberately constructed inside PowerShell.
$TfTopic = "/tf"
$ImageTopicPrefix = "/lerobot/render"
$ImageTopic = "$ImageTopicPrefix/$Sensor/image_raw"
& ros2 topic echo $TfTopic --once
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& ros2 topic list
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& ros2 topic info $ImageTopic --verbose
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& ros2 topic hz $ImageTopic
exit $LASTEXITCODE
