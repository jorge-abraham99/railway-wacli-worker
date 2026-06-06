create schema if not exists ai;

revoke all on schema ai from public;
revoke all on schema ai from anon;
revoke all on schema ai from authenticated;

create table if not exists ai.ai_chat_state (
  account_key text not null,
  chat_jid text not null,
  dirty_since timestamptz,
  last_message_at timestamptz,
  last_processed_at timestamptz,
  last_processed_message_at timestamptz,
  last_processed_message_id uuid,
  processing_status text not null default 'idle',
  processing_started_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_key, chat_jid),
  constraint ai_chat_state_processing_status_check
    check (processing_status in ('idle', 'pending', 'processing', 'error'))
);

create index if not exists ai_chat_state_dirty_idx
  on ai.ai_chat_state (processing_status, dirty_since, last_message_at);

create table if not exists ai.ai_extraction_runs (
  id uuid primary key default gen_random_uuid(),
  account_key text not null,
  chat_jid text not null,
  window_start_at timestamptz,
  window_end_at timestamptz,
  source_message_ids uuid[] not null default '{}',
  source_msg_ids text[] not null default '{}',
  candidate_reason text,
  status text not null default 'pending',
  error text,
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  dry_run boolean not null default false,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint ai_extraction_runs_status_check
    check (status in ('pending', 'skipped_no_candidate', 'success', 'error'))
);

create index if not exists ai_extraction_runs_chat_idx
  on ai.ai_extraction_runs (account_key, chat_jid, created_at desc);

create table if not exists ai.rfq_extractions (
  id uuid primary key default gen_random_uuid(),
  account_key text not null,
  chat_jid text not null,
  extraction_run_id uuid references ai.ai_extraction_runs(id) on delete set null,
  extraction_type text not null default 'rfq',
  summary text not null,
  confidence numeric not null default 0,
  source_message_ids uuid[] not null default '{}',
  source_msg_ids text[] not null default '{}',
  booking_status text not null default 'unknown',
  booking_status_confidence numeric not null default 0,
  extracted_json jsonb not null,
  raw_model_output jsonb,
  review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rfq_extractions_type_check
    check (extraction_type = 'rfq'),
  constraint rfq_extractions_booking_status_check
    check (booking_status in ('booked', 'not_booked', 'unknown')),
  constraint rfq_extractions_review_status_check
    check (review_status in ('pending', 'approved', 'rejected', 'needs_review'))
);

create index if not exists rfq_extractions_chat_idx
  on ai.rfq_extractions (account_key, chat_jid, created_at desc);

create index if not exists rfq_extractions_review_idx
  on ai.rfq_extractions (review_status, created_at desc);

create index if not exists rfq_extractions_extraction_run_id_idx
  on ai.rfq_extractions (extraction_run_id);

create index if not exists rfq_extractions_json_gin_idx
  on ai.rfq_extractions using gin (extracted_json);

create or replace function ai.mark_ai_chat_dirty()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into ai.ai_chat_state (
    account_key,
    chat_jid,
    dirty_since,
    last_message_at,
    processing_status,
    created_at,
    updated_at
  )
  values (
    new.account_key,
    new.chat_jid,
    coalesce(new.message_at, new.created_at, now()),
    coalesce(new.message_at, new.created_at, now()),
    'pending',
    now(),
    now()
  )
  on conflict (account_key, chat_jid)
  do update set
    dirty_since = coalesce(
      ai.ai_chat_state.dirty_since,
      coalesce(new.message_at, new.created_at, now())
    ),
    last_message_at = greatest(
      coalesce(ai.ai_chat_state.last_message_at, coalesce(new.message_at, new.created_at, now())),
      coalesce(new.message_at, new.created_at, now())
    ),
    processing_status = case
      when ai.ai_chat_state.processing_status = 'processing' then 'processing'
      else 'pending'
    end,
    updated_at = now();

  return new;
end;
$$;

revoke all on function ai.mark_ai_chat_dirty() from public, anon, authenticated;

drop trigger if exists trg_mark_ai_chat_dirty on public.wa_messages;

create trigger trg_mark_ai_chat_dirty
after insert on public.wa_messages
for each row
execute function ai.mark_ai_chat_dirty();

insert into ai.ai_chat_state (
  account_key,
  chat_jid,
  dirty_since,
  last_message_at,
  processing_status,
  created_at,
  updated_at
)
select
  m.account_key,
  m.chat_jid,
  min(coalesce(m.message_at, m.created_at)),
  max(coalesce(m.message_at, m.created_at)),
  'pending',
  now(),
  now()
from public.wa_messages m
left join ai.ai_chat_state s
  on s.account_key = m.account_key
 and s.chat_jid = m.chat_jid
where s.account_key is null
group by m.account_key, m.chat_jid;

create or replace function public.claim_dirty_chats(
  p_max_chats integer,
  p_idle_before timestamptz,
  p_stale_before timestamptz
)
returns table (
  account_key text,
  chat_jid text,
  dirty_since timestamptz,
  last_message_at timestamptz,
  last_processed_at timestamptz,
  last_processed_message_at timestamptz,
  last_processed_message_id uuid,
  processing_status text,
  processing_started_at timestamptz,
  attempts integer,
  last_error text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with eligible as (
    select s.account_key, s.chat_jid
    from ai.ai_chat_state s
    where s.dirty_since is not null
      and (
        (
          s.processing_status in ('pending', 'error')
          and coalesce(s.last_message_at, s.dirty_since, s.updated_at) <= p_idle_before
        )
        or (
          s.processing_status = 'processing'
          and s.processing_started_at is not null
          and s.processing_started_at <= p_stale_before
        )
      )
    order by s.dirty_since asc, s.last_message_at asc
    for update skip locked
    limit greatest(coalesce(p_max_chats, 0), 0)
  ),
  claimed as (
    update ai.ai_chat_state s
    set
      processing_status = 'processing',
      processing_started_at = now(),
      updated_at = now()
    from eligible e
    where s.account_key = e.account_key
      and s.chat_jid = e.chat_jid
    returning
      s.account_key,
      s.chat_jid,
      s.dirty_since,
      s.last_message_at,
      s.last_processed_at,
      s.last_processed_message_at,
      s.last_processed_message_id,
      s.processing_status,
      s.processing_started_at,
      s.attempts,
      s.last_error,
      s.created_at,
      s.updated_at
  )
  select * from claimed;
end;
$$;

create or replace function public.get_chat_message_window(
  p_account_key text,
  p_chat_jid text,
  p_last_processed_message_at timestamptz,
  p_max_messages integer,
  p_context_overlap_messages integer
)
returns table (
  id uuid,
  account_key text,
  chat_jid text,
  chat_name text,
  msg_id text,
  sender_jid text,
  sender_name text,
  from_me boolean,
  message_at timestamptz,
  created_at timestamptz,
  text text,
  display_text text,
  quoted_msg_id text,
  quoted_sender_jid text,
  media_type text,
  media_caption text,
  filename text,
  mime_type text,
  reaction_to_id text,
  reaction_emoji text,
  sort_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  with base as (
    select
      m.*,
      coalesce(m.message_at, m.created_at) as sort_at
    from public.wa_messages m
    where m.account_key = p_account_key
      and m.chat_jid = p_chat_jid
      and (
        p_last_processed_message_at is null
        or coalesce(m.message_at, m.created_at) >= p_last_processed_message_at
      )
    order by coalesce(m.message_at, m.created_at) desc, m.created_at desc
    limit greatest(coalesce(p_max_messages, 0), 0)
  ),
  overlap as (
    select
      m.*,
      coalesce(m.message_at, m.created_at) as sort_at
    from public.wa_messages m
    where p_last_processed_message_at is not null
      and m.account_key = p_account_key
      and m.chat_jid = p_chat_jid
      and coalesce(m.message_at, m.created_at) < p_last_processed_message_at
    order by coalesce(m.message_at, m.created_at) desc, m.created_at desc
    limit greatest(coalesce(p_context_overlap_messages, 0), 0)
  ),
  combined as (
    select * from base
    union
    select * from overlap
  ),
  quoted as (
    select
      m.*,
      coalesce(m.message_at, m.created_at) as sort_at
    from public.wa_messages m
    where m.account_key = p_account_key
      and m.chat_jid = p_chat_jid
      and exists (
        select 1
        from combined c
        where c.quoted_msg_id is not null
          and c.quoted_msg_id = m.msg_id
      )
  ),
  deduped as (
    select distinct on (m.id)
      m.id,
      m.account_key,
      m.chat_jid,
      m.chat_name,
      m.msg_id,
      m.sender_jid,
      m.sender_name,
      m.from_me,
      m.message_at,
      m.created_at,
      m.text,
      m.display_text,
      m.quoted_msg_id,
      m.quoted_sender_jid,
      m.media_type,
      m.media_caption,
      m.filename,
      m.mime_type,
      m.reaction_to_id,
      m.reaction_emoji,
      m.sort_at
    from (
      select * from combined
      union
      select * from quoted
    ) m
    order by m.id, m.sort_at desc, m.created_at desc
  ),
  limited as (
    select *
    from deduped
    order by sort_at desc, created_at desc, id desc
    limit greatest(coalesce(p_max_messages, 0), 0)
  )
  select *
  from limited
  order by sort_at asc, created_at asc, id asc;
$$;

create or replace function public.insert_ai_extraction_run(
  p_account_key text,
  p_chat_jid text,
  p_window_start_at timestamptz,
  p_window_end_at timestamptz,
  p_source_message_ids uuid[],
  p_source_msg_ids text[],
  p_candidate_reason text,
  p_status text,
  p_error text,
  p_model text,
  p_prompt_tokens integer,
  p_completion_tokens integer,
  p_total_tokens integer,
  p_dry_run boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into ai.ai_extraction_runs (
    account_key,
    chat_jid,
    window_start_at,
    window_end_at,
    source_message_ids,
    source_msg_ids,
    candidate_reason,
    status,
    error,
    model,
    prompt_tokens,
    completion_tokens,
    total_tokens,
    dry_run,
    completed_at
  )
  values (
    p_account_key,
    p_chat_jid,
    p_window_start_at,
    p_window_end_at,
    coalesce(p_source_message_ids, '{}'),
    coalesce(p_source_msg_ids, '{}'),
    p_candidate_reason,
    p_status,
    p_error,
    p_model,
    p_prompt_tokens,
    p_completion_tokens,
    p_total_tokens,
    coalesce(p_dry_run, false),
    case when p_status in ('skipped_no_candidate', 'success', 'error') then now() else null end
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.insert_rfq_extractions(
  p_account_key text,
  p_chat_jid text,
  p_extraction_run_id uuid,
  p_rfqs jsonb,
  p_dry_run boolean default false
)
returns table (
  inserted_count integer,
  skipped_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_summary text;
  v_confidence numeric;
  v_source_message_ids uuid[];
  v_source_msg_ids text[];
  v_extracted_json jsonb;
  v_booking_status text;
  v_booking_status_confidence numeric;
  v_inserted integer := 0;
  v_skipped integer := 0;
begin
  if p_rfqs is null or jsonb_typeof(p_rfqs) <> 'array' then
    raise exception 'p_rfqs must be a JSON array';
  end if;

  for v_item in
    select value
    from jsonb_array_elements(p_rfqs)
  loop
    v_summary := nullif(btrim(v_item->>'summary'), '');
    v_extracted_json := coalesce(v_item->'extracted_json', '{}'::jsonb);
    v_confidence := least(greatest(coalesce((v_item->>'confidence')::numeric, 0), 0), 1);
    v_booking_status := coalesce(v_extracted_json->>'booking_status', 'unknown');
    v_booking_status_confidence := least(
      greatest(coalesce((v_extracted_json->>'booking_status_confidence')::numeric, 0), 0),
      1
    );

    select coalesce(array_agg(distinct value::uuid), '{}')
      into v_source_message_ids
    from jsonb_array_elements_text(coalesce(v_item->'source_message_ids', '[]'::jsonb));

    select coalesce(array_agg(distinct value), '{}')
      into v_source_msg_ids
    from jsonb_array_elements_text(coalesce(v_item->'source_msg_ids', '[]'::jsonb));

    if v_summary is null or coalesce(array_length(v_source_message_ids, 1), 0) = 0 then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if exists (
      select 1
      from ai.rfq_extractions e
      where e.account_key = p_account_key
        and e.chat_jid = p_chat_jid
        and e.created_at >= now() - interval '6 hours'
        and e.source_msg_ids && v_source_msg_ids
        and lower(e.summary) = lower(v_summary)
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if not coalesce(p_dry_run, false) then
      insert into ai.rfq_extractions (
        account_key,
        chat_jid,
        extraction_run_id,
        extraction_type,
        summary,
        confidence,
        source_message_ids,
        source_msg_ids,
        booking_status,
        booking_status_confidence,
        extracted_json,
        raw_model_output
      )
      values (
        p_account_key,
        p_chat_jid,
        p_extraction_run_id,
        'rfq',
        v_summary,
        v_confidence,
        v_source_message_ids,
        coalesce(v_source_msg_ids, '{}'),
        case
          when v_booking_status in ('booked', 'not_booked', 'unknown') then v_booking_status
          else 'unknown'
        end,
        v_booking_status_confidence,
        jsonb_set(
          jsonb_set(v_extracted_json, '{booking_status}', to_jsonb(case
            when v_booking_status in ('booked', 'not_booked', 'unknown') then v_booking_status
            else 'unknown'
          end)),
          '{booking_status_confidence}',
          to_jsonb(v_booking_status_confidence)
        ),
        v_item
      );
    end if;

    if not coalesce(p_dry_run, false) then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return query
  select v_inserted, v_skipped;
end;
$$;

create or replace function public.complete_chat_processing(
  p_account_key text,
  p_chat_jid text,
  p_processed_message_at timestamptz,
  p_processed_message_id uuid
)
returns table (
  account_key text,
  chat_jid text,
  processing_status text,
  dirty_since timestamptz,
  last_message_at timestamptz,
  last_processed_at timestamptz,
  last_processed_message_at timestamptz,
  last_processed_message_id uuid,
  attempts integer,
  last_error text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with current_row as (
    select *
    from ai.ai_chat_state s
    where s.account_key = p_account_key
      and s.chat_jid = p_chat_jid
    for update
  ),
  updated as (
    update ai.ai_chat_state s
    set
      last_processed_at = now(),
      last_processed_message_at = coalesce(p_processed_message_at, s.last_processed_message_at),
      last_processed_message_id = coalesce(p_processed_message_id, s.last_processed_message_id),
      processing_started_at = null,
      attempts = 0,
      last_error = null,
      processing_status = case
        when c.processing_started_at is not null and c.updated_at > c.processing_started_at
          then 'pending'
        when p_processed_message_at is not null
          and coalesce(c.last_message_at, p_processed_message_at) > p_processed_message_at
          then 'pending'
        else 'idle'
      end,
      dirty_since = case
        when c.processing_started_at is not null and c.updated_at > c.processing_started_at
          then coalesce(c.dirty_since, c.last_message_at, now())
        when p_processed_message_at is not null
          and coalesce(c.last_message_at, p_processed_message_at) > p_processed_message_at
          then coalesce(c.dirty_since, c.last_message_at, p_processed_message_at, now())
        else null
      end,
      updated_at = now()
    from current_row c
    where s.account_key = c.account_key
      and s.chat_jid = c.chat_jid
    returning
      s.account_key,
      s.chat_jid,
      s.processing_status,
      s.dirty_since,
      s.last_message_at,
      s.last_processed_at,
      s.last_processed_message_at,
      s.last_processed_message_id,
      s.attempts,
      s.last_error,
      s.updated_at
  )
  select * from updated;
end;
$$;

create or replace function public.fail_chat_processing(
  p_account_key text,
  p_chat_jid text,
  p_error text
)
returns table (
  account_key text,
  chat_jid text,
  processing_status text,
  dirty_since timestamptz,
  attempts integer,
  last_error text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update ai.ai_chat_state s
  set
    processing_status = 'error',
    processing_started_at = null,
    attempts = s.attempts + 1,
    last_error = left(coalesce(p_error, 'Unknown error'), 2000),
    updated_at = now()
  where s.account_key = p_account_key
    and s.chat_jid = p_chat_jid
  returning
    s.account_key,
    s.chat_jid,
    s.processing_status,
    s.dirty_since,
    s.attempts,
    s.last_error,
    s.updated_at;
end;
$$;

revoke all on function public.claim_dirty_chats(integer, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.get_chat_message_window(text, text, timestamptz, integer, integer) from public, anon, authenticated;
revoke all on function public.insert_ai_extraction_run(text, text, timestamptz, timestamptz, uuid[], text[], text, text, text, text, integer, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.insert_rfq_extractions(text, text, uuid, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.complete_chat_processing(text, text, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.fail_chat_processing(text, text, text) from public, anon, authenticated;

grant execute on function public.claim_dirty_chats(integer, timestamptz, timestamptz) to service_role;
grant execute on function public.get_chat_message_window(text, text, timestamptz, integer, integer) to service_role;
grant execute on function public.insert_ai_extraction_run(text, text, timestamptz, timestamptz, uuid[], text[], text, text, text, text, integer, integer, integer, boolean) to service_role;
grant execute on function public.insert_rfq_extractions(text, text, uuid, jsonb, boolean) to service_role;
grant execute on function public.complete_chat_processing(text, text, timestamptz, uuid) to service_role;
grant execute on function public.fail_chat_processing(text, text, text) to service_role;
