-- Migration 021: Fix subreddit mancanti per slug con caratteri speciali
-- Il _slugify Python converte: ö→k, apostrofo→trattino.
-- La migration 020 usava slug pre-conversione; questa inserisce i 3 mancanti.

INSERT INTO game_subreddits (game_id, subreddit, subscriber_count)
SELECT g.id, s.subreddit, s.subscriber_count
FROM games g
JOIN (VALUES
    ('god-of-war-ragnar-k',      'GodofWar',    800000),
    ('uncharted-4-a-thief-s-end','uncharted',   200000),
    ('astro-s-playroom',         'AstrosBotGame', 80000)
) AS s(slug, subreddit, subscriber_count)
ON g.slug = s.slug
ON CONFLICT (game_id, subreddit) DO NOTHING;
