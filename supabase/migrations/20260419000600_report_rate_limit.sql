-- Rate-limit user reports so a single motivated troll can't flood the
-- queue. Cap is 20 open-or-recent reports from one reporter in any
-- rolling 24 hours. Exceeding the cap returns a clear error that the
-- ReportDialog surfaces inline.

create or replace function public.enforce_report_rate_limit()
returns trigger
language plpgsql
as $$
declare
  recent_count integer;
begin
  if new.reporter_id is null then
    return new;
  end if;
  select count(*) into recent_count
  from public.reports
  where reporter_id = new.reporter_id
    and created_at > now() - interval '1 day';
  if recent_count >= 20 then
    raise exception 'Too many reports in the last 24 hours. Please try again later.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger enforce_report_rate_limit_before_insert
  before insert on public.reports
  for each row execute function public.enforce_report_rate_limit();
