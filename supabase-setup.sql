-- Gestion 5S : tables à créer une seule fois dans Supabase.
-- Supabase > SQL Editor > New query > collez tout ce texte > Run.
-- Résultat attendu : « Success. No rows returned ».

create table if not exists public.docs (
  id          text primary key,     -- « collection/identifiant », par exemple reports/abc123
  col         text not null,        -- reports, departments, members, settings, photos
  doc_id      text not null,
  data        jsonb not null,       -- le contenu du document
  version     integer not null default 1,
  updated_at  bigint not null
);
create index if not exists docs_col_idx on public.docs (col);

create table if not exists public.meta (
  id     text primary key,          -- auth : comptes, sessions, clés de notification
  value  jsonb not null
);

-- Sécurité : personne ne peut lire ni écrire avec la clé publique.
-- Seul le serveur, avec la clé secrète, accède aux données.
alter table public.docs enable row level security;
alter table public.meta enable row level security;
