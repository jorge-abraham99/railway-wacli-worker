do $$
declare
  v_duplicates jsonb;
begin
  select jsonb_agg(row_to_json(duplicates))
    into v_duplicates
  from (
    select
      source_rfq_extraction_id,
      count(*) as duplicate_count,
      array_agg(id order by created_at asc) as opportunity_ids
    from public.opportunities
    where source_rfq_extraction_id is not null
    group by source_rfq_extraction_id
    having count(*) > 1
  ) duplicates;

  if v_duplicates is not null then
    raise exception 'Duplicate opportunities exist for source_rfq_extraction_id: %', v_duplicates;
  end if;
end;
$$;

create unique index if not exists opportunities_source_rfq_extraction_unique_idx
  on public.opportunities (source_rfq_extraction_id)
  where source_rfq_extraction_id is not null;

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
  updated_at timestamptz
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
    e.updated_at
  from ai.rfq_extractions e
  where e.extraction_type = 'rfq'
    and e.review_status in ('pending', 'approved', 'needs_review')
    and (
      e.review_status = 'approved'
      or e.confidence >= coalesce(p_min_confidence, 0.85)
    )
  order by e.created_at asc
  limit greatest(coalesce(p_limit, 50), 0);
$$;

create or replace function public.mark_rfq_extraction_needs_review(
  p_id uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  update ai.rfq_extractions e
  set
    review_status = 'needs_review',
    updated_at = now()
  where e.id = p_id
    and e.review_status = 'pending';
$$;

revoke all on function public.get_rfq_promotion_candidates(integer, numeric) from public, anon, authenticated;
revoke all on function public.mark_rfq_extraction_needs_review(uuid) from public, anon, authenticated;

grant execute on function public.get_rfq_promotion_candidates(integer, numeric) to service_role;
grant execute on function public.mark_rfq_extraction_needs_review(uuid) to service_role;
