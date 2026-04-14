-- Migration 020: Tabella game_subreddits
-- Mapping gioco → subreddit/i dedicati.
-- Usata dal Reddit collector per sapere dove cercare build, meta, tips.

CREATE TABLE IF NOT EXISTS game_subreddits (
    id               SERIAL PRIMARY KEY,
    game_id          INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    subreddit        VARCHAR(100) NOT NULL,
    subscriber_count INT,
    is_primary       BOOLEAN DEFAULT true,  -- false per subreddit secondari (es. r/Trophies)
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(game_id, subreddit)
);

CREATE INDEX IF NOT EXISTS idx_game_subreddits_game
ON game_subreddits(game_id);

-- Seed iniziale: subreddit ufficiali per i 24 giochi del seed
INSERT INTO game_subreddits (game_id, subreddit, subscriber_count)
SELECT g.id, s.subreddit, s.subscriber_count
FROM games g
JOIN (VALUES
    ('elden-ring',                      'Eldenring',           3000000),
    ('god-of-war-ragnar-k',             'GodofWar',             800000),
    ('marvels-spider-man-2',            'SpidermanPS4',         600000),
    ('baldurs-gate-3',                  'BaldursGate3',        1500000),
    ('final-fantasy-vii-rebirth',       'FFVIIRemake',          300000),
    ('the-last-of-us-part-ii-remastered','thelastofus',         800000),
    ('horizon-forbidden-west',          'horizon',              400000),
    ('ghost-of-tsushima',               'ghostoftsushima',      500000),
    ('dark-souls-iii',                  'darksouls3',           600000),
    ('sekiro-shadows-die-twice',        'Sekiro',               400000),
    ('bloodborne',                      'bloodborne',           700000),
    ('resident-evil-4',                 'residentevil',         500000),
    ('resident-evil-village',           'residentevil',         500000),
    ('uncharted-4-a-thief-s-end',        'uncharted',            200000),
    ('ratchet-clank-rift-apart',        'RatchetAndClank',      150000),
    ('returnal',                        'Returnal',             200000),
    ('demons-souls',                    'demonssouls',          200000),
    ('nioh-2',                          'Nioh',                 150000),
    ('hollow-knight',                   'HollowKnight',         500000),
    ('cyberpunk-2077',                  'cyberpunkgame',       1200000),
    ('the-witcher-3-wild-hunt',         'witcher',             1500000),
    ('red-dead-redemption-2',           'reddeadredemption2',   900000),
    ('death-stranding',                 'DeathStranding',       300000),
    ('astro-s-playroom',                'AstrosBotGame',         80000)
) AS s(slug, subreddit, subscriber_count)
ON g.slug = s.slug
ON CONFLICT (game_id, subreddit) DO NOTHING;
