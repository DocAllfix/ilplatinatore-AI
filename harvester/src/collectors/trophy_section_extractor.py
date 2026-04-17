"""TrophySectionExtractor — estrae sezioni per-trofeo da HTML di guide.

Supporta due strutture HTML:

1. **Heading-based** (PSNProfiles, GameFAQs e simili):
   Usa h2/h3/h4 come titoli di sezione per ogni trofeo.

2. **Anchor-based** (PowerPyx):
   Usa `<a id="trophy_name_slug">` come marker di sezione all'interno di
   `.entry-content`. Il contenuto segue i tag fratelli successivi fino
   al prossimo anchor con id.

Matching: fuzzy confronto tra heading text e trophy name_en via SequenceMatcher.
Soglia default 0.60 — accetta varianti come:
  "Yharnam Sunrise" ↔ "Yharnam Sunrise"         → 1.00 ✓
  "Platinum"        ↔ "Bloodborne" (platinum)    → 0.28 ✗ (skip corretto)
  "Hunter Craft"    ↔ "Hunter's Craft"           → 0.87 ✓
"""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher
from typing import TYPE_CHECKING

from bs4 import BeautifulSoup, NavigableString, Tag

if TYPE_CHECKING:
    pass

# Heading levels che delimitano sezioni trofeo (struttura heading-based).
_SECTION_HEADING_TAGS = {"h2", "h3", "h4"}

# Selettori da rimuovere prima dell'estrazione (nav, ads, commenti).
_JUNK_SELECTORS = [
    "nav", "aside", "footer", "header", "script", "style",
    "noscript", "form", ".sidebar", ".advertisement", ".ad-block",
    ".comments", ".comment-wrapper", ".share-buttons", ".pagination",
    "#sidebar", "#footer", "#comments",
]

# Lunghezza minima (char) di una sezione per essere considerata utile.
_MIN_SECTION_CHARS = 80

# Soglia fuzzy default.
_DEFAULT_THRESHOLD = 0.60

# Numero minimo di sezioni dall'estrazione heading-based perché venga preferita.
# Sotto questa soglia si tenta anche l'anchor-based e si prende il migliore.
_HEADING_MIN_SECTIONS = 3


def _normalize_name(text: str) -> str:
    """Normalizza il nome per il confronto: minuscolo, no accenti, solo alfanum/spazi."""
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9 ]", " ", text).strip()


def _similarity(a: str, b: str) -> float:
    """Similarity tra due stringhe normalizzate (0.0 – 1.0)."""
    na, nb = _normalize_name(a), _normalize_name(b)
    if not na or not nb:
        return 0.0
    return SequenceMatcher(None, na, nb).ratio()


def _anchor_id_to_name(anchor_id: str) -> str:
    """Converte un id anchor in un nome leggibile: underscore/trattini → spazi, title case."""
    name = re.sub(r"[_\-]+", " ", anchor_id)
    return name.strip().title()


def _is_trophy_anchor(tag: Tag, trophy_names_normalized: list[str]) -> bool:
    """True se il tag <a id="..."> ha un id che assomiglia a un nome di trofeo.

    Criteri:
    - Ha attributo `id` non vuoto.
    - L'id contiene almeno un underscore o lettere (non è un id numerico puro).
    - NON è un id di navigazione comune (es. 'top', 'content', 'main', 'nav', 'footer').
    """
    anchor_id = tag.get("id", "")
    if not anchor_id or not isinstance(anchor_id, str):
        return False
    # Escludi id numerici puri.
    if re.match(r"^\d+$", anchor_id):
        return False
    # Escludi id di navigazione comuni.
    _nav_ids = {"top", "content", "main", "nav", "footer", "header", "sidebar",
                "menu", "wrapper", "container", "page", "post", "entry"}
    if anchor_id.lower() in _nav_ids:
        return False
    # Deve avere almeno 3 caratteri.
    if len(anchor_id) < 3:
        return False
    return True


def _extract_sections_by_anchors(soup: BeautifulSoup) -> list[dict[str, str]]:
    """Estrazione anchor-based per PowerPyx e strutture simili.

    Cerca tutti i tag `<a id="...">` all'interno di `.entry-content` (o
    dell'intero body se non trovato). Per ogni anchor raccoglie il contenuto
    partendo dall'elemento PARENT dell'anchor (es. <p><a id="x">) e i suoi
    fratelli successivi, fino al prossimo anchor con id.

    Ritorna lista [{"heading": str, "content": str}].
    """
    # Cerca il container principale dei contenuti.
    container = soup.select_one(".entry-content, article, .post-content, main")
    if container is None:
        container = soup.body or soup

    # Trova tutti i tag <a> con id all'interno del container.
    anchors = [
        tag for tag in container.find_all("a")
        if tag.get("id") and _is_trophy_anchor(tag, [])
    ]

    if not anchors:
        return []

    sections: list[dict[str, str]] = []

    for i, anchor in enumerate(anchors):
        heading_text = _anchor_id_to_name(str(anchor.get("id", "")))
        next_anchor_id = str(anchors[i + 1].get("id", "")) if i + 1 < len(anchors) else None

        # Parti dal parent dell'anchor (es. <p> o <h3> che lo contiene).
        # In questo modo camminiamo i fratelli al livello corretto del DOM.
        start_elem: Tag | None = anchor.parent
        if start_elem is None or start_elem == container:
            start_elem = anchor  # fallback: usa l'anchor stesso

        content_parts: list[str] = []

        # Includi il testo dello start_elem stesso (es. il <p> con l'anchor
        # può contenere anche il titolo del trofeo dopo l'<a>).
        start_text = start_elem.get_text(separator=" ", strip=True)
        # Rimuovi testo di navigazione ovvio (solo numeri, "back to top", ecc.)
        if start_text and not re.match(r"^[\d\s]+$", start_text):
            content_parts.append(start_text)

        current = start_elem.next_sibling

        while current is not None:
            if isinstance(current, Tag):
                # Stop se il tag (o un suo discendente) contiene il prossimo anchor.
                if next_anchor_id and current.find("a", id=next_anchor_id):
                    break
                # Stop su heading di sezione principale.
                if current.name in _SECTION_HEADING_TAGS:
                    break
                text = current.get_text(separator=" ", strip=True)
                if text:
                    content_parts.append(text)
            elif isinstance(current, NavigableString):
                text = current.strip()
                if text:
                    content_parts.append(text)
            current = current.next_sibling

        content = " ".join(content_parts).strip()
        content = re.sub(r"\s+", " ", content)

        if len(content) >= _MIN_SECTION_CHARS:
            sections.append({"heading": heading_text, "content": content})

    return sections


def _extract_sections_by_headings(soup: BeautifulSoup) -> list[dict[str, str]]:
    """Estrazione heading-based: h2/h3/h4 come delimitatori di sezione."""
    sections: list[dict[str, str]] = []

    headings = soup.find_all(_SECTION_HEADING_TAGS)

    for heading in headings:
        heading_text = heading.get_text(separator=" ", strip=True)
        # Rimuovi prefissi tipo "Bronze", "Silver", "Gold", "Platinum" da PowerPyx.
        heading_text = re.sub(
            r"^(platinum|gold|silver|bronze)\s+", "", heading_text, flags=re.I
        ).strip()
        if not heading_text:
            continue

        # Raccoglie contenuto: fratelli successivi fino al prossimo heading.
        content_parts: list[str] = []
        current = heading.next_sibling

        while current is not None:
            if isinstance(current, Tag):
                if current.name in _SECTION_HEADING_TAGS:
                    break
                text = current.get_text(separator=" ", strip=True)
                if text:
                    content_parts.append(text)
            elif isinstance(current, NavigableString):
                text = current.strip()
                if text:
                    content_parts.append(text)
            current = current.next_sibling

        content = " ".join(content_parts).strip()
        content = re.sub(r"\s+", " ", content)

        if len(content) >= _MIN_SECTION_CHARS:
            sections.append({"heading": heading_text, "content": content})

    return sections


def extract_trophy_sections(html: str) -> list[dict[str, str]]:
    """Estrae sezioni per-trofeo da un HTML di guida.

    Ritorna lista di dict:
      [{"heading": "Trophy Name", "content": "Full section text..."}]

    Algoritmo:
      1. Parse HTML, rimuovi junk (nav, ads, script).
      2. Prova estrazione heading-based (h2/h3/h4).
      3. Se poche sezioni trovate (< _HEADING_MIN_SECTIONS), prova anche
         anchor-based (PowerPyx `<a id="trophy_slug">`).
      4. Restituisce il risultato con più sezioni tra i due metodi.
    """
    soup = BeautifulSoup(html, "html.parser")

    for sel in _JUNK_SELECTORS:
        for tag in soup.select(sel):
            tag.decompose()

    # Prova heading-based.
    heading_sections = _extract_sections_by_headings(soup)

    # Se heading-based dà risultati sufficienti, usalo direttamente.
    if len(heading_sections) >= _HEADING_MIN_SECTIONS:
        return heading_sections

    # Altrimenti prova anchor-based (PowerPyx).
    anchor_sections = _extract_sections_by_anchors(soup)

    # Restituisce il metodo che ha trovato più sezioni.
    if len(anchor_sections) > len(heading_sections):
        return anchor_sections

    return heading_sections


def match_trophies_to_sections(
    sections: list[dict[str, str]],
    trophy_names: list[str],
    threshold: float = _DEFAULT_THRESHOLD,
) -> dict[str, str]:
    """Associa ogni trophy_name alla sezione con heading più simile.

    Ritorna dict: {trophy_name_en → section_content}.
    Un trofeo viene incluso SOLO se la similarity supera la soglia.
    Un trofeo non può essere abbinato a due volte alla stessa sezione
    (la sezione viene marcata come usata dopo il primo match migliore).

    Esempio:
      "Yharnam Sunrise" (similarity 1.0 con heading "Yharnam Sunrise") → incluso.
      "Bloodborne" platinum (similarity 0.28 con heading "Bloodborne Platinum")
        → incluso se supera threshold, ma la guida platinum è "completa tutte".
    """
    if not sections or not trophy_names:
        return {}

    used_indices: set[int] = set()
    result: dict[str, str] = {}

    for trophy_name in trophy_names:
        best_score = 0.0
        best_idx = -1

        for idx, section in enumerate(sections):
            if idx in used_indices:
                continue
            score = _similarity(trophy_name, section["heading"])
            if score > best_score:
                best_score = score
                best_idx = idx

        if best_score >= threshold and best_idx >= 0:
            result[trophy_name] = sections[best_idx]["content"]
            used_indices.add(best_idx)

    return result
