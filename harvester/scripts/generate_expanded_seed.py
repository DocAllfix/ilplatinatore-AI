"""Genera expanded_seed.json dai giochi PS5/PS4 più rilevanti nel DB.

Criteri priorità:
1. Giochi PS5 + PS4 insieme (cross-gen = più popolare)
2. Giochi con trofei già nel DB (PSN ci ha già dato i dati)
3. Escludi giochi già con guide
4. Ordine: prima PS5, poi per numero di trofei desc
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))


# Giochi top da aggiungere manualmente (AAA noti con guida PowerPyx)
PRIORITY_GAMES = [
    # PS5 exclusives/big titles
    {"title": "Marvel's Spider-Man 2", "slug": "spider-man-2",
     "powerpyx_url": "https://www.powerpyx.com/marvels-spider-man-2-trophy-guide/"},
    {"title": "God of War Ragnarök", "slug": "god-of-war-ragnarok"},
    {"title": "Horizon Forbidden West", "slug": "horizon-forbidden-west",
     "powerpyx_url": "https://www.powerpyx.com/horizon-forbidden-west-trophy-guide-roadmap/"},
    {"title": "Ratchet & Clank: Rift Apart", "slug": "ratchet-and-clank-rift-apart",
     "powerpyx_url": "https://www.powerpyx.com/ratchet-clank-rift-apart-trophy-guide/"},
    {"title": "Demon's Souls", "slug": "demons-souls",
     "powerpyx_url": "https://www.powerpyx.com/demons-souls-ps5-remake-trophy-guide-roadmap/"},
    {"title": "Astro's Playroom", "slug": "astros-playroom"},
    {"title": "Returnal", "slug": "returnal"},
    # Cross-gen AAA
    {"title": "Elden Ring", "slug": "elden-ring"},
    {"title": "Ghost of Tsushima", "slug": "ghost-of-tsushima"},
    {"title": "Cyberpunk 2077", "slug": "cyberpunk-2077"},
    {"title": "Red Dead Redemption 2", "slug": "red-dead-redemption-2"},
    {"title": "The Witcher 3: Wild Hunt", "slug": "the-witcher-3-wild-hunt"},
    {"title": "Death Stranding", "slug": "death-stranding"},
    {"title": "Uncharted 4: A Thief's End", "slug": "uncharted-4-a-thiefs-end"},
    {"title": "Bloodborne", "slug": "bloodborne"},
    {"title": "Sekiro: Shadows Die Twice", "slug": "sekiro-shadows-die-twice"},
    {"title": "Nioh 2", "slug": "nioh-2"},
    # PS4 AAA
    {"title": "Dark Souls III", "slug": "dark-souls-iii",
     "powerpyx_url": "https://www.powerpyx.com/dark-souls-3-trophy-guide/"},
    {"title": "Resident Evil 4 Remake", "slug": "resident-evil-4",
     "powerpyx_url": "https://www.powerpyx.com/resident-evil-4-remake-trophy-guide/"},
    {"title": "Resident Evil Village", "slug": "resident-evil-village",
     "powerpyx_url": "https://www.powerpyx.com/resident-evil-8-village-trophy-guide-roadmap/"},
    # Grandi titoli con buona copertura PowerPyx
    {"title": "Batman: Arkham Knight", "slug": "batman-arkham-knight"},
    {"title": "Spyro Reignited Trilogy", "slug": "spyro-reignited-trilogy"},
    {"title": "Crash Bandicoot N. Sane Trilogy", "slug": "crash-bandicoot-n-sane-trilogy"},
    {"title": "Spider-Man: Miles Morales", "slug": "spider-man-miles-morales"},
    {"title": "Sackboy: A Big Adventure", "slug": "sackboy-a-big-adventure"},
    {"title": "Kena: Bridge of Spirits", "slug": "kena-bridge-of-spirits"},
    {"title": "It Takes Two", "slug": "it-takes-two"},
    {"title": "A Plague Tale: Innocence", "slug": "a-plague-tale-innocence"},
    {"title": "A Plague Tale: Requiem", "slug": "a-plague-tale-requiem"},
    {"title": "Little Nightmares II", "slug": "little-nightmares-ii"},
    {"title": "Stray", "slug": "stray"},
    {"title": "Greedfall", "slug": "greedfall"},
    {"title": "Ghostrunner", "slug": "ghostrunner"},
    {"title": "Scarlet Nexus", "slug": "scarlet-nexus"},
    {"title": "Tales of Arise", "slug": "tales-of-arise"},
    {"title": "Monster Hunter Rise", "slug": "monster-hunter-rise"},
    {"title": "Monster Hunter World", "slug": "monster-hunter-world"},
    {"title": "Dragon Age: The Veilguard", "slug": "dragon-age-the-veilguard"},
    {"title": "Mass Effect: Legendary Edition", "slug": "mass-effect-legendary-edition"},
    {"title": "Assassin's Creed Mirage", "slug": "assassins-creed-mirage"},
    {"title": "Assassin's Creed Valhalla", "slug": "assassins-creed-valhalla"},
    {"title": "Watch Dogs: Legion", "slug": "watch-dogs-legion"},
    {"title": "Far Cry 6", "slug": "far-cry-6"},
    {"title": "Ghost of Tsushima: Director's Cut", "slug": "ghost-of-tsushima-directors-cut"},
    {"title": "Deathloop", "slug": "deathloop"},
    {"title": "Ghostwire: Tokyo", "slug": "ghostwire-tokyo"},
    {"title": "Sifu", "slug": "sifu"},
    {"title": "Tunic", "slug": "tunic"},
    {"title": "Hollow Knight", "slug": "hollow-knight",
     "trueachievements_url": "https://www.trueachievements.com/game/Hollow-Knight/achievements"},
    {"title": "Hades", "slug": "hades"},
    {"title": "Disco Elysium", "slug": "disco-elysium"},
    {"title": "Control", "slug": "control"},
    {"title": "Outer Wilds", "slug": "outer-wilds"},
    {"title": "Celeste", "slug": "celeste"},
    {"title": "Blasphemous", "slug": "blasphemous"},
    {"title": "Ori and the Will of the Wisps", "slug": "ori-and-the-will-of-the-wisps"},
    {"title": "Cuphead", "slug": "cuphead"},
    {"title": "Persona 5 Royal", "slug": "persona-5-royal"},
    {"title": "Persona 4 Golden", "slug": "persona-4-golden"},
    {"title": "Final Fantasy XVI", "slug": "final-fantasy-xvi"},
    {"title": "Baldur's Gate 3", "slug": "baldurs-gate-3",
     "trueachievements_url": "https://www.trueachievements.com/game/Baldurs-Gate-3/achievements"},
    {"title": "Alan Wake 2", "slug": "alan-wake-2"},
    {"title": "Lies of P", "slug": "lies-of-p"},
    {"title": "Star Wars Jedi: Survivor", "slug": "star-wars-jedi-survivor"},
    {"title": "Star Wars Jedi: Fallen Order", "slug": "star-wars-jedi-fallen-order"},
    {"title": "Wo Long: Fallen Dynasty", "slug": "wo-long-fallen-dynasty"},
    {"title": "Nioh: Complete Edition", "slug": "nioh-complete-edition"},
    {"title": "Dark Souls Remastered", "slug": "dark-souls-remastered"},
    {"title": "Dark Souls II: Scholar of the First Sin", "slug": "dark-souls-ii-scholar-of-the-first-sin"},
    {"title": "Code Vein", "slug": "code-vein"},
    {"title": "Remnant: From the Ashes", "slug": "remnant-from-the-ashes"},
    {"title": "Remnant II", "slug": "remnant-ii"},
    {"title": "Mortal Kombat 11", "slug": "mortal-kombat-11"},
    {"title": "Street Fighter 6", "slug": "street-fighter-6"},
    {"title": "Tekken 8", "slug": "tekken-8"},
    {"title": "Doom Eternal", "slug": "doom-eternal"},
    {"title": "Quake", "slug": "quake"},
    {"title": "Wolfenstein II: The New Colossus", "slug": "wolfenstein-ii-the-new-colossus"},
    {"title": "Prey", "slug": "prey"},
    {"title": "Dishonored 2", "slug": "dishonored-2"},
    {"title": "Deathloop", "slug": "deathloop"},
    {"title": "Metal Gear Solid V: The Phantom Pain", "slug": "metal-gear-solid-v-the-phantom-pain"},
    {"title": "Yakuza: Like a Dragon", "slug": "yakuza-like-a-dragon"},
    {"title": "Like a Dragon: Ishin!", "slug": "like-a-dragon-ishin"},
    {"title": "Judgment", "slug": "judgment"},
    {"title": "Lost Judgment", "slug": "lost-judgment"},
    {"title": "NieR:Automata", "slug": "nierautomata"},
    {"title": "NieR Replicant", "slug": "nier-replicant"},
    {"title": "Dragon Quest XI S", "slug": "dragon-quest-xi-s"},
    {"title": "Octopath Traveler II", "slug": "octopath-traveler-ii"},
    {"title": "Xenoblade Chronicles 3", "slug": "xenoblade-chronicles-3"},
    {"title": "Crisis Core: Final Fantasy VII Reunion", "slug": "crisis-core-final-fantasy-vii-reunion"},
    {"title": "Final Fantasy VII Rebirth", "slug": "final-fantasy-vii-rebirth",
     "trueachievements_url": "https://www.trueachievements.com/game/Final-Fantasy-7-Rebirth/achievements"},
    {"title": "Forspoken", "slug": "forspoken"},
    {"title": "Gotham Knights", "slug": "gotham-knights"},
    {"title": "Marvel's Midnight Suns", "slug": "marvels-midnight-suns"},
    {"title": "Hogwarts Legacy", "slug": "hogwarts-legacy"},
    {"title": "Dead Space Remake", "slug": "dead-space"},
    {"title": "Callisto Protocol", "slug": "callisto-protocol"},
    {"title": "Dying Light 2 Stay Human", "slug": "dying-light-2"},
    {"title": "The Last of Us Part I", "slug": "the-last-of-us-part-i"},
    {"title": "Uncharted: Legacy of Thieves Collection", "slug": "uncharted-legacy-of-thieves-collection"},
    {"title": "God of War (2018)", "slug": "god-of-war"},
    {"title": "Horizon Zero Dawn", "slug": "horizon-zero-dawn"},
    {"title": "Days Gone", "slug": "days-gone"},
    {"title": "Ghost of Tsushima", "slug": "ghost-of-tsushima"},
    {"title": "Marvel's Spider-Man Remastered", "slug": "marvels-spider-man-remastered"},
]


async def main() -> None:
    from src.config.db import close_pool, init_pool
    from src.config.logger import get_logger

    logger = get_logger("generate_expanded_seed")
    await init_pool()

    try:
        # Deduplicazione: rimuovi duplicati per slug
        seen_slugs: set[str] = set()
        unique_games = []
        for g in PRIORITY_GAMES:
            slug = g["slug"]
            if slug not in seen_slugs:
                seen_slugs.add(slug)
                unique_games.append(g)

        seed_path = Path(__file__).parent.parent / "seeds" / "expanded_seed.json"
        seed_path.write_text(json.dumps(unique_games, indent=2, ensure_ascii=False), encoding="utf-8")
        logger.info(
            "expanded_seed.json generato",
            count=len(unique_games),
            path=str(seed_path),
        )
        print(f"\nSeed generato: {len(unique_games)} giochi")
        print(f"Path: {seed_path}")

    finally:
        await close_pool()


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
