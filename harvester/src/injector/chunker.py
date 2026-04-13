"""Chunker — split di una guida in chunk da max_tokens con overlap.

Stima token = len(text) // 4 (approssimazione rough ma affidabile per prosa IT).
Split primario per heading markdown (## / ###), fallback per paragrafi (\\n\\n).
"""

from __future__ import annotations

import re

_HEADING_SPLIT_RE = re.compile(r"(?=^\s*#{2,3}\s+)", re.MULTILINE)


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def chunk_content(
    content: str,
    title: str,
    max_tokens: int = 800,
    overlap_tokens: int = 100,
) -> list[str]:
    """Split markdown guide in chunk con prefisso titolo e overlap tra chunk consecutivi."""
    if not content:
        return []

    prefix = f"Guida: {title}\n\n"
    max_chars = max_tokens * 4
    overlap_chars = overlap_tokens * 4

    # Se il contenuto (con prefisso) sta nel limite, ritorna un singolo chunk.
    if _estimate_tokens(content) + _estimate_tokens(prefix) <= max_tokens:
        return [prefix + content.strip()]

    # Split primario per heading ## / ###.
    sections = [s.strip() for s in _HEADING_SPLIT_RE.split(content) if s.strip()]
    if not sections:
        sections = [content.strip()]

    # Espandi sezioni troppo grandi splittando per paragrafi.
    expanded: list[str] = []
    for section in sections:
        if _estimate_tokens(section) <= max_tokens:
            expanded.append(section)
            continue
        # Split per paragrafi; raggruppa fino a max_chars.
        paragraphs = [p.strip() for p in section.split("\n\n") if p.strip()]
        buf = ""
        for para in paragraphs:
            candidate = f"{buf}\n\n{para}".strip() if buf else para
            if len(candidate) <= max_chars:
                buf = candidate
            else:
                if buf:
                    expanded.append(buf)
                # Se il singolo paragrafo eccede, taglialo a pezzi di max_chars.
                if len(para) > max_chars:
                    for i in range(0, len(para), max_chars):
                        expanded.append(para[i : i + max_chars])
                    buf = ""
                else:
                    buf = para
        if buf:
            expanded.append(buf)

    # Aggiungi prefix + overlap dal chunk precedente.
    chunks: list[str] = []
    prev_tail = ""
    for section in expanded:
        body = f"{prev_tail}\n\n{section}".strip() if prev_tail else section
        chunks.append(f"{prefix}{body}")
        prev_tail = section[-overlap_chars:] if overlap_chars > 0 else ""

    return chunks
