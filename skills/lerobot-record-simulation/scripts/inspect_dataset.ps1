param(
    [Parameter(Mandatory = $true)] [string]$DatasetRoot,
    [string]$RepoId = "local/random-to-goal",
    [int]$Episode = 0
)
$ErrorActionPreference = "Stop"
$SkillRoot = Split-Path $PSScriptRoot -Parent
Push-Location $SkillRoot
try {
    & uv run lerobot-info
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & uv run lerobot-dataset-viz --repo-id $RepoId --root $DatasetRoot --mode local --episode-index $Episode
    exit $LASTEXITCODE
} finally { Pop-Location }
