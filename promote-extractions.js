import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import ws from 'ws';

const DEFAULT_LIMIT = 50;
const DEFAULT_MIN_CONFIDENCE = 0.85;
const DEFAULT_OPPORTUNITY_DEDUPE_WINDOW_HOURS = 72;
const RECENT_OPPORTUNITY_WINDOW_HOURS = intEnv(
  'OPPORTUNITY_DEDUPE_WINDOW_HOURS',
  DEFAULT_OPPORTUNITY_DEDUPE_WINDOW_HOURS,
);
const ACTIVE_OPPORTUNITY_STATUSES = ['new', 'needs_review'];

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
      const sourceMessages = await fetchSourceMessages(supabase, extraction.source_message_ids);
      const existingOpportunity = await findExistingOpportunity(supabase, extraction, sourceMessages);
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

      let promotedOpportunityId;
      if (existingOpportunity) {
        await updateOpportunity(supabase, existingOpportunity.id, opportunity);
        promotedOpportunityId = existingOpportunity.id;
        summary.updated += 1;
      } else {
        promotedOpportunityId = await insertOpportunity(supabase, opportunity);
        summary.inserted += 1;
      }

      await markExtractionPromoted(supabase, extraction.id, promotedOpportunityId);

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

  const mergedSourceMessageIds = mergeDistinctValues(existingOpportunity.source_message_ids, sourceMessageIds);
  const mergedSourceMsgIds = mergeDistinctValues(existingOpportunity.source_msg_ids, sourceMsgIds);
  const existingRawSource = objectValue(existingOpportunity.raw_source);

  return {
    ...insertPayload,
    received_date: earliestIso(existingOpportunity.received_date, receivedDate),
    last_contact_at: latestIso(existingOpportunity.last_contact_at, lastContactAt),
    customer: existingOpportunity.customer || sourceCustomer,
    contact: existingOpportunity.contact || sourceContact,
    source_message_ids: mergedSourceMessageIds,
    source_msg_ids: mergedSourceMsgIds,
    raw_source: {
      ...insertPayload.raw_source,
      merged_rfq_extraction_ids: mergeDistinctValues(
        arrayValue(existingRawSource.merged_rfq_extraction_ids),
        [existingOpportunity.source_rfq_extraction_id, extraction.id],
      ),
      merged_source_message_ids: mergedSourceMessageIds,
      merged_source_msg_ids: mergedSourceMsgIds,
      latest_rfq_extraction_id: extraction.id,
    },
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

async function findExistingOpportunity(supabase, extraction, sourceMessages) {
  const exactOpportunity = await findOpportunityBySourceExtraction(supabase, extraction.id);
  if (exactOpportunity) {
    return exactOpportunity;
  }

  return findRecentMatchingOpportunity(supabase, extraction, sourceMessages);
}

async function findOpportunityBySourceExtraction(supabase, extractionId) {
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

async function findRecentMatchingOpportunity(supabase, extraction, sourceMessages) {
  const referenceAt = extractionReferenceAt(extraction, sourceMessages);
  const windowStart = new Date(referenceAt.getTime() - RECENT_OPPORTUNITY_WINDOW_HOURS * 60 * 60 * 1000);
  const windowEnd = new Date(referenceAt.getTime() + RECENT_OPPORTUNITY_WINDOW_HOURS * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('opportunities')
    .select('*')
    .eq('account_key', extraction.account_key)
    .eq('chat_jid', extraction.chat_jid)
    .in('status', ACTIVE_OPPORTUNITY_STATUSES)
    .order('received_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    throw new Error(`find recent matching opportunity failed: ${error.message}`);
  }

  const opportunities = Array.isArray(data) ? data : [];
  return opportunities.find((opportunity) =>
    isLikelySameOpportunity(opportunity, extraction, sourceMessages, windowStart, windowEnd),
  ) || null;
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
  const { data, error } = await supabase
    .from('opportunities')
    .insert(opportunity)
    .select('id')
    .single();

  if (error) {
    throw new Error(`insert opportunity failed: ${error.message}`);
  }

  return data.id;
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

async function markExtractionPromoted(supabase, extractionId, opportunityId) {
  const { error } = await supabase.rpc('mark_rfq_extraction_promoted', {
    p_extraction_id: extractionId,
    p_opportunity_id: opportunityId,
  });

  if (error) {
    throw new Error(`mark extraction promoted failed: ${error.message}`);
  }
}

function shouldMoveToNeedsReview(extraction, minConfidence) {
  return extraction.review_status === 'pending' && numberOrNull(extraction.confidence) >= minConfidence;
}

function opportunityId(extractionId) {
  return `RFQ-${String(extractionId).slice(0, 8).toUpperCase()}`;
}

function extractionReferenceAt(extraction, sourceMessages) {
  const sourceDates = sourceMessages
    .map((message) => timestampMs(message.message_at))
    .filter((value) => value !== null);
  const earliestSourceDate = sourceDates.length > 0 ? Math.min(...sourceDates) : null;
  const extractionDate = timestampMs(extraction.created_at);
  const fallback = extractionDate ?? Date.now();
  return new Date(earliestSourceDate ?? fallback);
}

function isLikelySameOpportunity(opportunity, extraction, sourceMessages, windowStart, windowEnd) {
  const opportunityAt = opportunityReferenceAt(opportunity);
  if (!opportunityAt || opportunityAt < windowStart || opportunityAt > windowEnd) {
    return false;
  }

  const extractionJson = objectValue(extraction.extracted_json);
  const opportunityJson = objectValue(opportunity.raw_source?.extracted_json);

  if (
    arrayOverlap(arrayValue(opportunity.source_message_ids), arrayValue(extraction.source_message_ids))
    || arrayOverlap(arrayValue(opportunity.source_msg_ids), arrayValue(extraction.source_msg_ids))
  ) {
    return true;
  }

  const originMatches = sameNormalizedText(extractionJson.origin, opportunityJson.origin);
  const destinationMatches = sameNormalizedText(extractionJson.destination, opportunityJson.destination);
  if (!originMatches || !destinationMatches) {
    return false;
  }

  let signalCount = 0;

  if (sameNormalizedNumber(extractionJson.container_count, opportunityJson.container_count)) {
    signalCount += 1;
  }

  if (sameNormalizedText(extractionJson.commodity, opportunity.material_type, opportunityJson.commodity)) {
    signalCount += 1;
  }

  if (sameNormalizedText(extractionJson.shipping_line, opportunityJson.shipping_line)) {
    signalCount += 1;
  }

  if (sameNormalizedText(extractionJson.load_window, opportunityJson.load_window)) {
    signalCount += 1;
  }

  if (sameNumericFingerprint(extractionJson.quoted_price, opportunityJson.quoted_price)) {
    signalCount += 1;
  }

  return signalCount >= 2;
}

function opportunityReferenceAt(opportunity) {
  const receivedAt = timestampMs(opportunity.received_date);
  const createdAt = timestampMs(opportunity.created_at);
  const fallback = timestampMs(opportunity.updated_at);
  const ms = receivedAt ?? createdAt ?? fallback;
  return ms === null ? null : new Date(ms);
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

function arrayOverlap(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) {
    return false;
  }

  const rightValues = new Set(right);
  return left.some((value) => rightValues.has(value));
}

function mergeDistinctValues(left, right) {
  return Array.from(new Set([
    ...arrayValue(left),
    ...arrayValue(right),
  ]));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameNormalizedNumber(left, right) {
  const leftNumber = numberOrNull(left);
  const rightNumber = numberOrNull(right);
  if (leftNumber === null || rightNumber === null) return false;
  return Math.floor(leftNumber) === Math.floor(rightNumber);
}

function sameNormalizedText(...values) {
  const normalized = values
    .map(normalizeText)
    .filter(Boolean);

  if (normalized.length < 2) return false;
  return normalized.every((value) => value === normalized[0]);
}

function sameNumericFingerprint(left, right) {
  const leftFingerprint = numericFingerprint(left);
  const rightFingerprint = numericFingerprint(right);
  if (!leftFingerprint || !rightFingerprint) return false;
  return leftFingerprint === rightFingerprint;
}

function numericFingerprint(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }

  if (typeof value === 'string') {
    const matches = value.match(/-?\d+(?:\.\d+)?/g);
    if (!matches || matches.length === 0) return null;
    return Array.from(new Set(matches)).sort().join('|');
  }

  if (Array.isArray(value)) {
    const nested = value
      .map((item) => numericFingerprint(item))
      .filter(Boolean);
    return nested.length > 0 ? Array.from(new Set(nested)).sort().join('|') : null;
  }

  if (typeof value === 'object') {
    const nested = Object.values(value)
      .map((item) => numericFingerprint(item))
      .filter(Boolean);
    return nested.length > 0 ? Array.from(new Set(nested)).sort().join('|') : null;
  }

  return null;
}

function normalizeText(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return normalized || null;
}

function timestampMs(value) {
  if (!value) return null;

  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function earliestIso(...values) {
  const timestamps = values
    .map(timestampMs)
    .filter((value) => value !== null);
  if (timestamps.length === 0) return null;
  return new Date(Math.min(...timestamps)).toISOString();
}

function latestIso(...values) {
  const timestamps = values
    .map(timestampMs)
    .filter((value) => value !== null);
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
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

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
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
