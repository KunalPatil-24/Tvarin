-- Tvarin backend schema (run once in the Supabase SQL editor).
--
-- Stores only a per-user monthly draft counter. No resume text, no answers —
-- the resume lives in the extension and is sent fresh with each request.

-- 1. Usage table: one row per user per month.
create table if not exists public.usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  period  text not null,                    -- 'YYYY-MM' (UTC)
  count   integer not null default 0,
  primary key (user_id, period)
);

alter table public.usage enable row level security;

-- Users may READ their own usage (for the "drafts left" indicator).
-- Writes happen only through the SECURITY DEFINER function below — there is no
-- insert/update policy, so clients can't tamper with their own counts.
drop policy if exists "read own usage" on public.usage;
create policy "read own usage"
  on public.usage for select
  using (user_id = auth.uid());

-- 2. Atomic "consume one draft" with a monthly limit.
--    Returns { allowed, used, limit }. The conditional UPDATE (count < limit)
--    makes the check-and-increment race-free.
create or replace function public.consume_draft(monthly_limit integer)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_period text := to_char(timezone('utc', now()), 'YYYY-MM');
  v_cur    integer;
begin
  if v_uid is null then
    return json_build_object('allowed', false, 'error', 'not_authenticated');
  end if;

  insert into public.usage (user_id, period, count)
    values (v_uid, v_period, 0)
    on conflict (user_id, period) do nothing;

  update public.usage
    set count = count + 1
    where user_id = v_uid
      and period = v_period
      and count < monthly_limit
    returning count into v_cur;

  if v_cur is null then
    -- At (or over) the limit — return the current count without incrementing.
    select count into v_cur from public.usage
      where user_id = v_uid and period = v_period;
    return json_build_object('allowed', false, 'used', coalesce(v_cur, 0), 'limit', monthly_limit);
  end if;

  return json_build_object('allowed', true, 'used', v_cur, 'limit', monthly_limit);
end;
$$;

grant execute on function public.consume_draft(integer) to authenticated;
