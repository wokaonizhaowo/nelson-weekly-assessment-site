-- Run this file once in Supabase Dashboard > SQL Editor.
-- Then create two users in Authentication > Users:
--   nelson@nelson-study.app
--   parent@nelson-study.app
-- Disable public sign-ups in Authentication settings.

create table if not exists public.nelson_family_state (
  family_id text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.nelson_family_state enable row level security;

drop policy if exists "nelson family can read" on public.nelson_family_state;
create policy "nelson family can read"
on public.nelson_family_state
for select
to authenticated
using (
  family_id = 'nelson-family'
  and (auth.jwt() ->> 'email') in (
    'nelson@nelson-study.app',
    'parent@nelson-study.app'
  )
);

drop policy if exists "nelson family can insert" on public.nelson_family_state;
create policy "nelson family can insert"
on public.nelson_family_state
for insert
to authenticated
with check (
  family_id = 'nelson-family'
  and updated_by = auth.uid()
  and (auth.jwt() ->> 'email') in (
    'nelson@nelson-study.app',
    'parent@nelson-study.app'
  )
);

drop policy if exists "nelson family can update" on public.nelson_family_state;
create policy "nelson family can update"
on public.nelson_family_state
for update
to authenticated
using (
  family_id = 'nelson-family'
  and (auth.jwt() ->> 'email') in (
    'nelson@nelson-study.app',
    'parent@nelson-study.app'
  )
)
with check (
  family_id = 'nelson-family'
  and updated_by = auth.uid()
  and (auth.jwt() ->> 'email') in (
    'nelson@nelson-study.app',
    'parent@nelson-study.app'
  )
);
