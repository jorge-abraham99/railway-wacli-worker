import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import ws from 'ws';

const DEFAULT_LIMIT = 50;
const DEFAULT_MIN_CONFIDENCE = 0.85;

export async function promoteExtractions(options = {}) {
  const supabase = options.supabase || createSupabaseClient();
  const limit = options.limit || DEFAULT_LIMIT;
  const minConfidence = options.minConfidence || DEFAULT_MIN_CONFIDENCE;
  const dryRun = options.dryRun ?? boolEnv('DRY_RUN', false);

  const summary = {
    step: 'promote_extractions',
    candidates: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  const candidates = await fetchCandidates(supabase, limit, minConfidence);
  summary.candidates = candidates.length;

  for (const extraction of candidates) {
    try {
      const existingOpportunity = await findExistingOpportunity(supabase, extraction.id);
      const sourceMessages = await fetchSourceMessages(supabase, extraction.source_message_ids);
      const shouldMarkNeedsReview = shouldMoveToNeedsReview(extraction, minConfidence);
      const opportunity = buildOpportunityPayload(extraction, {
        existingOpportunity,
        sourceMessages,
        reviewStatus: shouldMarkNeedsReview ? 'needs_review' : extraction.review_status,
      });

      if (dryRun) {
        summary.skipped += 1;
        continue;
      }

      if (existingOpportunity) {
        await updateOpportunity(supabase, existingOpportunity.id, opportunity);
        summary.updated += 1;
      } else {
        await insertOpportunity(supabase, opportunity);
        summary.inserted += 1;
      }

      if (shouldMarkNeedsReview) {
        await markExtractionNeedsReview(supabase, extraction.id);
      }
    } catch (error) {
      summary.failed += 1;
      console.error(JSON.stringify({
        level: 'error',
        step: 'promote_extraction_failed',
        rfq_extraction_id: extraction.id,
        error: error.message,
      }));
    }
  }

  console.log(JSON.stringify({
    level: 'info',
    ...summary,
  }));

  return summary;
}

export function buildOpportunityPayload(extraction, options = {}) {
  const extractedJson = objectValue(extraction.extracted_json);
  const existingOpportunity = options.existingOpportunity || null;
  const sourceMessages = Array.isArray(options.sourceMessages) ? options.sourceMessages : [];
  const reviewStatus = options.reviewStatus || extraction.review_status;
  const sourceMessageIds = arrayValue(extraction.source_message_ids);
  const sourceMsgIds = arrayValue(extraction.source_msg_ids);
  const sourceDates = sourceMessages
    .map((message) => timestampMs(message.message_at))
    .filter((value) => value !== null);
  const fallbackDate = isoOrNull(extraction.created_at);
  const receivedDate = sourceDates.length > 0
    ? new Date(Math.min(...sourceDates)).toISOString()
    : fallbackDate;
  const lastContactAt = sourceDates.length > 0
    ? new Date(Math.max(...sourceDates)).toISOString()
    : fallbackDate;
  const sourceCustomer = firstText(extractedJson.customer, extractedJson.customer_name);
  const sourceContact = firstText(extractedJson.contact) || firstInboundSenderName(sourceMessages);

  const insertPayload = {
    opportunity_id: opportunityId(extraction.id),
    opportunity_title: opportunityTitle(extraction, extractedJson),
    status: opportunityStatus(reviewStatus, extraction.booking_status || extractedJson.booking_status),
    customer: sourceCustomer,
    received_date: receivedDate,
    load_count: parseLoadCount(extractedJson.container_count),
    contact: sourceContact,
    material_type: firstText(extractedJson.commodity),
    last_contact_at: lastContactAt,
    channel: 'whatsapp',
    notes: firstText(extractedJson.notes),
    description: buildDescription(extraction, extractedJson),
    conversation_thread_ref: extraction.chat_jid ? `whatsapp:${extraction.chat_jid}` : null,
    account_key: extraction.account_key,
    chat_jid: extraction.chat_jid,
    source_message_ids: sourceMessageIds,
    source_msg_ids: sourceMsgIds,
    source_rfq_extraction_id: extraction.id,
    trigger_type: 'ai_rfq_extraction',
    import_source: 'wacli_ai_worker',
    raw_source: {
      rfq_extraction_id: extraction.id,
      extraction_run_id: extraction.extraction_run_id,
      confidence: numberOrNull(extraction.confidence),
      booking_status: extraction.booking_status || extractedJson.booking_status || 'unknown',
      booking_status_confidence: numberOrNull(extraction.booking_status_confidence),
      review_status: reviewStatus,
      summary: extraction.summary,
      extracted_json: extractedJson,
      source_msg_ids: sourceMsgIds,
    },
    updated_at: new Date().toISOString(),
  };

  if (!existingOpportunity) {
    return insertPayload;
  }

  return {
    ...insertPayload,
    customer: existingOpportunity.customer || sourceCustomer,
    contact: existingOpportunity.contact || sourceContact,
  };
}

function createSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) throw new Error('SUPABASE_URL is required');
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: ws,
    },
  });
}

async function fetchCandidates(supabase, limit, minConfidence) {
  const { data, error } = await supabase.rpc('get_rfq_promotion_candidates', {
    p_limit: limit,
    p_min_confidence: minConfidence,
  });

  if (error) {
    throw new Error(`fetch RFQ promotion candidates failed: ${error.message}`);
  }

  return data || [];
}

async function findExistingOpportunity(supabase, extractionId) {
  const { data, error } = await supabase
    .from('opportunities')
    .select('*')
    .eq('source_rfq_extraction_id', extractionId)
    .order('created_at', { ascending: true })
    .limit(2);

  if (error) {
    throw new Error(`find existing opportunity failed: ${error.message}`);
  }

  if ((data || []).length > 1) {
    throw new Error(`multiple opportunities found for source_rfq_extraction_id ${extractionId}`);
  }

  return data?.[0] || null;
}

async function fetchSourceMessages(supabase, sourceMessageIds) {
  const ids = arrayValue(sourceMessageIds);

  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from('wa_messages')
    .select('id,message_at,sender_name,from_me')
    .in('id', ids);

  if (error) {
    throw new Error(`fetch source messages failed: ${error.message}`);
  }

  return (data || []).sort((a, b) => {
    const left = timestampMs(a.message_at) ?? Number.MAX_SAFE_INTEGER;
    const right = timestampMs(b.message_at) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

async function insertOpportunity(supabase, opportunity) {
  const { error } = await supabase
    .from('opportunities')
    .insert(opportunity);

  if (error) {
    throw new Error(`insert opportunity failed: ${error.message}`);
  }
}

async function updateOpportunity(supabase, opportunityId, opportunity) {
  const updatePayload = { ...opportunity };
  delete updatePayload.opportunity_id;
  delete updatePayload.source_rfq_extraction_id;

  const { error } = await supabase
    .from('opportunities')
    .update(updatePayload)
    .eq('id', opportunityId);

  if (error) {
    throw new Error(`update opportunity failed: ${error.message}`);
  }
}

async function markExtractionNeedsReview(supabase, extractionId) {
  const { error } = await supabase.rpc('mark_rfq_extraction_needs_review', {
    p_id: extractionId,
  });

  if (error) {
    throw new Error(`mark extraction needs_review failed: ${error.message}`);
  }
}

function shouldMoveToNeedsReview(extraction, minConfidence) {
  return extraction.review_status === 'pending' && numberOrNull(extraction.confidence) >= minConfidence;
}

function opportunityId(extractionId) {
  return `RFQ-${String(extractionId).slice(0, 8).toUpperCase()}`;
}

function opportunityTitle(extraction, extractedJson) {
  const origin = firstText(extractedJson.origin);
  const destination = firstText(extractedJson.destination);
  const title = origin && destination ? `${origin} -> ${destination}` : firstText(extraction.summary);
  return truncateText(title || opportunityId(extraction.id), 120);
}

function opportunityStatus(reviewStatus, bookingStatus) {
  if (reviewStatus === 'needs_review') return 'needs_review';

  if (bookingStatus === 'booked') return 'booked';
  if (bookingStatus === 'not_booked') return 'lost';
  return 'new';
}

function parseLoadCount(value) {
  if (value === null || value === undefined || value === '') return 0;

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;

  return Math.floor(number);
}

function firstInboundSenderName(sourceMessages) {
  const message = sourceMessages.find((item) => item.from_me === false && firstText(item.sender_name));
  return firstText(message?.sender_name);
}

function buildDescription(extraction, extractedJson) {
  const fields = [
    ['Summary', extraction.summary],
    ['Origin', extractedJson.origin],
    ['Destination', extractedJson.destination],
    ['Container count', extractedJson.container_count],
    ['Container type', extractedJson.container_type],
    ['Weight', extractedJson.weight_tons],
    ['Shipping line', extractedJson.shipping_line],
    ['Incoterm', extractedJson.incoterm],
    ['Customer target price', extractedJson.customer_target_price],
    ['Quoted price', extractedJson.quoted_price],
    ['Currency', extractedJson.currency],
    ['Load window', extractedJson.load_window],
    ['Booking status', extraction.booking_status || extractedJson.booking_status],
    ['Notes', extractedJson.notes],
  ];

  return fields
    .map(([label, value]) => [label, descriptionValue(value)])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

function descriptionValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : null;
  if (typeof value === 'object') return null;
  return String(value).trim() || null;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  return null;
}

function truncateText(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trim()}...`;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value) {
  if (!value) return null;

  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isoOrNull(value) {
  const ms = timestampMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  promoteExtractions().catch((error) => {
    console.error(JSON.stringify({
      level: 'error',
      step: 'promote_extractions_failed',
      error: error.message,
    }));
    process.exitCode = 1;
  });
}
