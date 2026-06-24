alter table ai.rfq_extractions
  add column if not exists promoted_at timestamptz;

update ai.rfq_extractions e
set promoted_at = coalesce(e.promoted_at, o.created_at, e.updated_at, now())
from public.opportunities o
where o.source_rfq_extraction_id = e.id
  and e.promoted_at is null;

update ai.rfq_extractions e
set promoted_at = coalesce(e.promoted_at, e.updated_at, now())
where e.promoted_opportunity_id is not null
  and e.promoted_at is null;

drop function if exists public.get_rfq_promotion_candidates(integer, numeric);

create or replace function public.get_rfq_promotion_candidates(
  p_limit integer default 50,
  p_min_confidence numeric default 0.85
)
returns table (
  id uuid,
  account_key text,
  chat_jid text,
  extraction_run_id uuid,
  extraction_type text,
  summary text,
  confidence numeric,
  source_message_ids uuid[],
  source_msg_ids text[],
  booking_status text,
  booking_status_confidence numeric,
  extracted_json jsonb,
  raw_model_output jsonb,
  review_status text,
  created_at timestamptz,
  updated_at timestamptz,
  promoted_opportunity_id uuid
)
language sql
security definer
set search_path = ''
as $$
  select
    e.id,
    e.account_key,
    e.chat_jid,
    e.extraction_run_id,
    e.extraction_type,
    e.summary,
    e.confidence,
    e.source_message_ids,
    e.source_msg_ids,
    e.booking_status,
    e.booking_status_confidence,
    e.extracted_json,
    e.raw_model_output,
    e.review_status,
    e.created_at,
    e.updated_at,
    e.promoted_opportunity_id
  from ai.rfq_extractions e
  where e.promoted_at is null
    and not exists (
      select 1
      from public.opportunities o
      where o.source_rfq_extraction_id = e.id
    )
    and e.extraction_type = 'rfq'
    and e.review_status in ('pending', 'approved', 'needs_review')
    and (
      e.review_status = 'approved'
      or e.confidence >= coalesce(p_min_confidence, 0.85)
    )
  order by e.created_at asc
  limit greatest(coalesce(p_limit, 50), 0);
$$;

create or replace function public.mark_rfq_extraction_promoted(
  p_extraction_id uuid,
  p_opportunity_id uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  update ai.rfq_extractions e
  set
    promoted_opportunity_id = p_opportunity_id,
    promoted_at = coalesce(e.promoted_at, now()),
    updated_at = now()
  where e.id = p_extraction_id;
$$;

revoke all on function public.mark_rfq_extraction_promoted(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mark_rfq_extraction_promoted(uuid, uuid) to service_role;
