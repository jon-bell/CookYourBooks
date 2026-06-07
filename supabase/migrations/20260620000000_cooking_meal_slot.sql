-- Meal slot on cooking events.
--
-- Adds a day-part to a cook ("Sunday DINNER") so entries can be grouped
-- and cooked together by occasion. App-level enum
-- (BREAKFAST/LUNCH/DINNER/SNACK); no CHECK so new slots never need a
-- migration. The existing `occasion_note` free text remains the
-- "any other occasion" field (now surfaced via a creatable autocomplete).
alter table public.cooking_events
  add column meal_slot text;

-- Grouping a day's cooks by slot rides this.
create index cooking_events_owner_slot_idx
  on public.cooking_events(owner_id, event_date, meal_slot);
