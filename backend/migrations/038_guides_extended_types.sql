-- Migration 038: aggiunge 'general' al CHECK constraint di guides.guide_type.
-- Il constraint attuale include già: trophy, walkthrough, collectible, challenge,
-- platinum, boss, build, puzzle, meta, lore, faq (da migrazione precedente).
-- Aggiungiamo 'general' per supportare le nuove risposte da game_guide_links.

ALTER TABLE guides DROP CONSTRAINT IF EXISTS guides_guide_type_check;
ALTER TABLE guides ADD CONSTRAINT guides_guide_type_check
  CHECK (guide_type IN (
    'trophy', 'walkthrough', 'collectible', 'challenge', 'platinum',
    'boss', 'build', 'puzzle', 'meta', 'lore', 'faq', 'general'
  ));
