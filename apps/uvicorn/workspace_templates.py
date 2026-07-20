"""Startup-loaded workspace UI template registry."""

import logging
import os
from pathlib import Path

from pydantic import ValidationError

from models import WorkspaceTemplate

logger = logging.getLogger(__name__)
_templates: dict[str, WorkspaceTemplate] = {}


def template_root() -> Path:
    configured = os.getenv("SILVERRETORT_TEMPLATE_ROOT", "").strip()
    if configured:
        return Path(configured).resolve()
    return Path(__file__).resolve().parents[2] / "template"


def load_templates(root: Path | None = None) -> list[WorkspaceTemplate]:
    source = (root or template_root()).resolve()
    loaded: dict[str, WorkspaceTemplate] = {}
    if not source.is_dir():
        logger.info("workspace template directory does not exist: %s", source)
        _templates.clear()
        return []

    for config_path in sorted(source.glob("*.json")):
        try:
            template = WorkspaceTemplate.model_validate_json(
                config_path.read_text(encoding="utf-8")
            )
        except (OSError, UnicodeError, ValidationError, ValueError) as exc:
            logger.warning("skipping invalid workspace template %s: %s", config_path, exc)
            continue
        if template.id in loaded:
            logger.warning(
                "skipping duplicate workspace template id %s from %s",
                template.id,
                config_path,
            )
            continue
        loaded[template.id] = template

    _templates.clear()
    _templates.update(loaded)
    logger.info("loaded %d workspace templates from %s", len(_templates), source)
    return list_templates()


def list_templates() -> list[WorkspaceTemplate]:
    return list(_templates.values())


def get_template(template_id: str) -> WorkspaceTemplate | None:
    return _templates.get(template_id)
