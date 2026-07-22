[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("PatchCollision", "PickupProbe", "PickupGenerate")]
    [string]$Action,
    [Parameter(Mandatory = $true)] [string]$Scene,
    [string]$Output,
    [string]$DatasetRoot,
    [string]$RepoId = "local/moz01-pick",
    [int]$Episodes = 1,
    [string]$Sensors = "front,closeup",
    [int]$Width = 320,
    [int]$Height = 240
)
$ErrorActionPreference = "Stop"
$SkillRoot = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path -LiteralPath $Scene -PathType Leaf)) { throw "Scene not found: $Scene" }
Push-Location $SkillRoot
try {
    switch ($Action) {
        "PatchCollision" {
            if (-not $Output) { throw "-Output is required for PatchCollision" }
            & uv run python scripts\patch_moz01_usd.py $Scene $Output
        }
        "PickupProbe" {
            & uv run python scripts\moz01\pickup_probe.py $Scene
        }
        "PickupGenerate" {
            if (-not $DatasetRoot) { throw "-DatasetRoot is required for PickupGenerate" }
            & uv run python scripts\moz01\pickup_pipeline.py generate `
                --scene $Scene --root $DatasetRoot --repo-id $RepoId --episodes $Episodes `
                --sensors $Sensors --width $Width --height $Height
        }
    }
    exit $LASTEXITCODE
} finally { Pop-Location }
