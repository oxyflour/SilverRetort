param()
$ErrorActionPreference = "Stop"
$SkillRoot = Split-Path $PSScriptRoot -Parent
Push-Location $SkillRoot
try {
    & uv run pytest
    exit $LASTEXITCODE
} finally { Pop-Location }
