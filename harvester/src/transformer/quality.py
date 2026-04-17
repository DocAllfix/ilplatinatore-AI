"""Quality scoring per guide sintetizzate dal Transformer.

Algoritmo Masterplan:
  40% campi obbligatori presenti
  20% lunghezza contenuto (>= 500 char → pieno)
  20% steps numerati (>= 3 → pieno, proporzionale altrimenti)
  10% lingua italiana (language == "it")
  10% presenza sezione consigli/tips
"""

from __future__ import annotations

import re

_REQUIRED_FIELDS = (
    "title",
    "content",
    "game_name",
    "trophy_name",
    "guide_type",
    "language",
)

_STEP_RE = re.compile(r"^\s*(\d+)[\.\)]\s+", re.MULTILINE)
_TIPS_RE = re.compile(r"consigli|tips|strateg", re.IGNORECASE)

_MIN_FULL_LENGTH = 2000  # soglia saturazione lunghezza: 500 era troppo bassa (un paragrafo)
_MIN_FULL_STEPS = 5      # soglia saturazione step: 3 è il minimo assoluto, 5 è una guida reale


def calculate_quality_score(guide: dict) -> float:
    """Calcola un quality score in [0.0, 1.0] arrotondato a 2 decimali."""
    if not isinstance(guide, dict) or not guide:
        return 0.0

    # 40% — campi obbligatori presenti e non vuoti
    present = sum(1 for f in _REQUIRED_FIELDS if guide.get(f))
    score_fields = 0.40 * (present / len(_REQUIRED_FIELDS))

    content = guide.get("content") or ""

    # 20% — lunghezza (saturazione a 500 char)
    length_ratio = min(1.0, len(content) / _MIN_FULL_LENGTH)
    score_length = 0.20 * length_ratio

    # 20% — steps numerati (saturazione a 3)
    steps = len(_STEP_RE.findall(content))
    steps_ratio = min(1.0, steps / _MIN_FULL_STEPS)
    score_steps = 0.20 * steps_ratio

    # 10% — lingua valida (sintetizzata dal nostro pipeline)
    score_lang = 0.10 if guide.get("language") in ("it", "en") else 0.0

    # 10% — sezione consigli/tips
    score_tips = 0.10 if _TIPS_RE.search(content) else 0.0

    total = score_fields + score_length + score_steps + score_lang + score_tips
    return round(min(1.0, total), 2)
