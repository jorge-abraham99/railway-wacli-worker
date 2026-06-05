import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { promoteExtractions } from './promote-extractions.js';

const SYSTEM_PROMPT = `You are an information extraction engine for commercial logistics WhatsApp conversations.

Extract only RFQs: requests for quotation, freight quote opportunities, haulage jobs, transport pricing requests, container movements, booking confirmations related to a quote, or quote lifecycle updates.

Rules:
1. Extract ONLY RFQs.
2. Ignore greetings, relationship-building, market commentary, generic follow-ups, and supplier marketing blasts unless clearly tied to a customer RFQ.
3. Every extracted item must have extraction_type = "rfq".
4. booking_status must be one of: "booked", "not_booked", "unknown".
5. Use only information present in the messages.
6. A conversation window may contain zero, one, or multiple RFQs.
7. source_message_ids must contain the exact database UUIDs from input messages supporting the RFQ.
8. source_msg_ids must contain the original WhatsApp msg_id values supporting the RFQ.
9. confidence and booking_status_confidence must be numbers between 0 and 1.
10. Prefer RFQs initiated by the customer/requesting party.
11. Supplier replies may provide supporting details, quoted prices, and booking evidence, but should not create a new RFQ by themselves unless they clearly reference a customer quote request in the same window.
12. If a customer says "book it", "go ahead", "please book", or similar after a quoted price, set booking_status to "booked".
13. If the conversation contains a price from OUR_SIDE, capture it as quoted_price.
14. If the customer gives a target/budget price, capture it as customer_target_price.
15. Return strict JSON only. No markdown, no code fences, no commentary.

Output shape:
{
  "rfqs": [
    {
      "summary": "short plain-English summary",
      "extraction_type": "rfq",
      "confidence": 0.0,
      "source_message_ids": ["database_uuid_1"],
      "source_msg_ids": ["whatsapp_msg_id_1"],
      "extracted_json": {
        "commodity": null,
        "origin": null,
        "destination": null,
        "origin_postcode": null,
        "destination_postcode": null,
        "container_count": null,
        "container_type": null,
        "weight_tons": null,
        "shipping_line": null,
        "incoterm": null,
        "customer_target_price": null,
        "quoted_price": null,
        "currency": null,
        "load_window": null,
        "booking_status": "unknown",
        "booking_status_confidence": 0.0,
        "notes": null
      }
    }
  ]
}

If no RFQs are found, return { "rfqs": [] }.`;

const DEFAULT_EXTRACTED_JSON = {
  commodity: null,
  origin: null,
  destination: null,
  origin_postcode: null,
  destination_postcode: null,
  container_count: null,
  container_type: null,
  weight_tons: null,
  shipping_line: null,
  incoterm: null,
  customer_target_price: null,
  quoted_price: null,
  currency: null,
  load_window: null,
  booking_status: 'unknown',
  booking_status_confidence: 0,
  notes: null,
};

const KEYWORD_RULES = [
  ['keyword:quote', /\bquote\b/i],
  ['keyword:rate', /\brate\b/i],
  ['keyword:price', /\bprice\b/i],
  ['keyword:cost', /\bcost\b/i],
  ['keyword:how_much', /\bhow much\b/i],
  ['keyword:availability', /\bavailability\b/i],
  ['keyword:collection', /\bcollection\b/i],
  ['keyword:delivery', /\bdelivery\b/i],
  ['keyword:load', /\bloads?\b/i],
  ['keyword:haulage', /\bhaulage\b/i],
  ['keyword:freight', /\bfreight\b/i],
  ['keyword:container', /\bcontainer\b/i],
  ['keyword:trailer', /\btrailer\b/i],
  ['keyword:job', /\bjob\b/i],
  ['keyword:book_it', /\bbook it\b/i],
  ['keyword:go_ahead', /\bgo ahead\b/i],
  ['keyword:please_book', /\bplease book\b/i],
  ['keyword:can_you_price', /\bcan you price\b/i],
  ['keyword:need_a_rate', /\bneed a rate\b/i],
  ['keyword:can_you_cover', /\bcan you cover\b/i],
  ['keyword:port', /\b(?:felixstowe|southampton|tilbury|london gateway)\b/i],
  ['keyword:city', /\b(?:manchester|birmingham|leeds|liverpool)\b/i],
];

const CURRENCY_RE = /[£$€]/;
const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
const US_ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;
const CONTAINER_RE = /\b(?:20|40|45)\s?(?:ft)\b|\bHC\b/i;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL || 'openai/gpt-5.1';
const WORKER_INTERVAL_SECONDS = intEnv('WORKER_INTERVAL_SECONDS', 300);
const CHAT_IDLE_MINUTES = intEnv('CHAT_IDLE_MINUTES', 10);
const PROCESSING_STALE_MINUTES = intEnv('PROCESSING_STALE_MINUTES', 30);
const MAX_CHATS_PER_CYCLE = intEnv('MAX_CHATS_PER_CYCLE', 10);
const MAX_MESSAGES_PER_WINDOW = intEnv('MAX_MESSAGES_PER_WINDOW', 40);
const CONTEXT_OVERLAP_MESSAGES = intEnv('CONTEXT_OVERLAP_MESSAGES', 15);
const DRY_RUN = boolEnv('DRY_RUN', false);

if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    transport: ws,
  },
});

async function main() {
  console.log(JSON.stringify({
    level: 'info',
    msg: 'rfq-ai-worker booting',
    model: LLM_MODEL,
    dry_run: DRY_RUN,
    interval_seconds: WORKER_INTERVAL_SECONDS,
    idle_minutes: CHAT_IDLE_MINUTES,
    stale_minutes: PROCESSING_STALE_MINUTES,
    max_chats_per_cycle: MAX_CHATS_PER_CYCLE,
    max_messages_per_window: MAX_MESSAGES_PER_WINDOW,
    context_overlap_messages: CONTEXT_OVERLAP_MESSAGES,
  }));

  while (true) {
    const cycleStartedAt = new Date();
    const summary = await runCycle(cycleStartedAt);
    await runPromotionStep();

    console.log(JSON.stringify({
      level: 'info',
      msg: 'cycle complete',
      cycle_started_at: cycleStartedAt.toISOString(),
      ...summary,
    }));

    await sleep(WORKER_INTERVAL_SECONDS * 1000);
  }
}

async function runPromotionStep() {
  try {
    await promoteExtractions({
      supabase,
      dryRun: DRY_RUN,
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      step: 'promote_extractions_failed',
      error: error.message,
    }));
  }
}

async function runCycle(now) {
  const claimedChats = await claimDirtyChats(now);
  const summary = {
    claimed_chats: claimedChats.length,
    processed_chats: 0,
    skipped_no_candidate: 0,
    successful_runs: 0,
    failed_runs: 0,
    inserted_rfqs: 0,
    skipped_duplicate_rfqs: 0,
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_tokens: 0,
  };

  for (const chat of claimedChats) {
    const chatSummary = await processChat(chat);
    summary.processed_chats += 1;
    summary.skipped_no_candidate += chatSummary.skipped_no_candidate;
    summary.successful_runs += chatSummary.successful_runs;
    summary.failed_runs += chatSummary.failed_runs;
    summary.inserted_rfqs += chatSummary.inserted_rfqs;
    summary.skipped_duplicate_rfqs += chatSummary.skipped_duplicate_rfqs;
    summary.total_prompt_tokens += chatSummary.prompt_tokens;
    summary.total_completion_tokens += chatSummary.completion_tokens;
    summary.total_tokens += chatSummary.total_tokens;
  }

  return summary;
}

async function claimDirtyChats(now) {
  const idleBefore = new Date(now.getTime() - CHAT_IDLE_MINUTES * 60_000).toISOString();
  const staleBefore = new Date(now.getTime() - PROCESSING_STALE_MINUTES * 60_000).toISOString();
  const { data, error } = await supabase.rpc('claim_dirty_chats', {
    p_max_chats: MAX_CHATS_PER_CYCLE,
    p_idle_before: idleBefore,
    p_stale_before: staleBefore,
  });

  if (error) {
    throw new Error(`claim_dirty_chats failed: ${error.message}`);
  }

  return data || [];
}

async function processChat(chat) {
  const summary = {
    skipped_no_candidate: 0,
    successful_runs: 0,
    failed_runs: 0,
    inserted_rfqs: 0,
    skipped_duplicate_rfqs: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  try {
    const windowMessages = await getChatMessageWindow(chat);

    if (windowMessages.length === 0) {
      await completeChatProcessing(chat, null, null);
      logChat(chat, {
        status: 'success',
        reason: 'empty_window',
        window_size: 0,
      });
      return summary;
    }

    const windowInfo = buildWindowInfo(windowMessages);
    const candidate = detectCandidate(windowMessages);

    if (!candidate.isCandidate) {
      await insertAiExtractionRun({
        account_key: chat.account_key,
        chat_jid: chat.chat_jid,
        window_start_at: windowInfo.windowStartAt,
        window_end_at: windowInfo.windowEndAt,
        source_message_ids: windowInfo.sourceMessageIds,
        source_msg_ids: windowInfo.sourceMsgIds,
        candidate_reason: candidate.reason,
        status: 'skipped_no_candidate',
        error: null,
        model: null,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        dry_run: DRY_RUN,
      });

      await completeChatProcessing(chat, windowInfo.windowEndAt, windowInfo.lastMessageId);
      summary.skipped_no_candidate += 1;

      logChat(chat, {
        status: 'skipped_no_candidate',
        candidate_reason: candidate.reason,
        window_size: windowMessages.length,
      });

      return summary;
    }

    const promptText = formatPromptInput(windowMessages);
    const modelResult = await callModel(chat, promptText);
    summary.prompt_tokens += modelResult.usage.prompt_tokens;
    summary.completion_tokens += modelResult.usage.completion_tokens;
    summary.total_tokens += modelResult.usage.total_tokens;

    const sanitized = sanitizeModelOutput(modelResult.output, windowMessages);
    const runId = await insertAiExtractionRun({
      account_key: chat.account_key,
      chat_jid: chat.chat_jid,
      window_start_at: windowInfo.windowStartAt,
      window_end_at: windowInfo.windowEndAt,
      source_message_ids: windowInfo.sourceMessageIds,
      source_msg_ids: windowInfo.sourceMsgIds,
      candidate_reason: candidate.reason,
      status: 'success',
      error: null,
      model: LLM_MODEL,
      prompt_tokens: modelResult.usage.prompt_tokens,
      completion_tokens: modelResult.usage.completion_tokens,
      total_tokens: modelResult.usage.total_tokens,
      dry_run: DRY_RUN,
    });

    let insertedCounts = { inserted_count: 0, skipped_count: 0 };
    if (sanitized.rfqs.length > 0) {
      insertedCounts = await insertRfqExtractions(chat, runId, sanitized.rfqs);
    }

    await completeChatProcessing(chat, windowInfo.windowEndAt, windowInfo.lastMessageId);

    summary.successful_runs += 1;
    summary.inserted_rfqs += insertedCounts.inserted_count;
    summary.skipped_duplicate_rfqs += insertedCounts.skipped_count;

    logChat(chat, {
      status: 'success',
      candidate_reason: candidate.reason,
      window_size: windowMessages.length,
      rfq_count: sanitized.rfqs.length,
      inserted_rfqs: insertedCounts.inserted_count,
      skipped_duplicate_rfqs: insertedCounts.skipped_count,
      prompt_tokens: modelResult.usage.prompt_tokens,
      completion_tokens: modelResult.usage.completion_tokens,
      total_tokens: modelResult.usage.total_tokens,
    });

    return summary;
  } catch (error) {
    summary.failed_runs += 1;

    try {
      await insertAiExtractionRun({
        account_key: chat.account_key,
        chat_jid: chat.chat_jid,
        window_start_at: null,
        window_end_at: null,
        source_message_ids: [],
        source_msg_ids: [],
        candidate_reason: null,
        status: 'error',
        error: error.message,
        model: LLM_MODEL,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        dry_run: DRY_RUN,
      });
    } catch (runError) {
      console.error(JSON.stringify({
        level: 'error',
        msg: 'failed to persist error extraction run',
        account_key: chat.account_key,
        chat_jid: chat.chat_jid,
        error: runError.message,
      }));
    }

    await failChatProcessing(chat, error.message);

    logChat(chat, {
      status: 'error',
      error: error.message,
    });

    return summary;
  }
}

async function getChatMessageWindow(chat) {
  const { data, error } = await supabase.rpc('get_chat_message_window', {
    p_account_key: chat.account_key,
    p_chat_jid: chat.chat_jid,
    p_last_processed_message_at: chat.last_processed_message_at,
    p_max_messages: MAX_MESSAGES_PER_WINDOW,
    p_context_overlap_messages: CONTEXT_OVERLAP_MESSAGES,
  });

  if (error) {
    throw new Error(`get_chat_message_window failed: ${error.message}`);
  }

  return data || [];
}

function buildWindowInfo(windowMessages) {
  const first = windowMessages[0];
  const last = windowMessages[windowMessages.length - 1];

  return {
    windowStartAt: first.sort_at || first.message_at || first.created_at,
    windowEndAt: last.sort_at || last.message_at || last.created_at,
    lastMessageId: last.id,
    sourceMessageIds: unique(windowMessages.map((message) => message.id).filter(Boolean)),
    sourceMsgIds: unique(windowMessages.map((message) => message.msg_id).filter(Boolean)),
  };
}

function detectCandidate(windowMessages) {
  const reasons = new Set();
  const joinedText = windowMessages
    .map((message) => [
      message.display_text,
      message.text,
      message.media_caption,
      message.filename,
      message.chat_name,
    ].filter(Boolean).join(' '))
    .join('\n');

  for (const [label, pattern] of KEYWORD_RULES) {
    if (pattern.test(joinedText)) reasons.add(label);
  }

  if (CURRENCY_RE.test(joinedText)) reasons.add('pattern:currency');
  if (UK_POSTCODE_RE.test(joinedText) || US_ZIP_RE.test(joinedText)) reasons.add('pattern:postcode');
  if (CONTAINER_RE.test(joinedText)) reasons.add('pattern:container_size');

  for (const message of windowMessages) {
    if (message.media_caption) reasons.add('signal:media_caption');
    if (message.quoted_msg_id) reasons.add('signal:reply_context');
  }

  return {
    isCandidate: reasons.size > 0,
    reason: Array.from(reasons).sort().join(', ') || 'none',
  };
}

function formatPromptInput(windowMessages) {
  return windowMessages.map(formatMessageLine).join('\n');
}

function formatMessageLine(message) {
  const parts = [
    `[${message.sort_at || message.message_at || message.created_at}]`,
    `[db_id:${message.id}]`,
    `[msg_id:${message.msg_id}]`,
    `[${message.from_me ? 'OUR_SIDE' : 'OTHER_PARTY'}]`,
  ];

  if (message.sender_name || message.sender_jid) {
    parts.push(`[sender:${message.sender_name || message.sender_jid}]`);
  }

  if (message.quoted_msg_id) {
    parts.push(`[reply_to_msg_id:${message.quoted_msg_id}]`);
  }

  if (message.reaction_to_id && message.reaction_emoji) {
    parts.push(`[reaction:${message.reaction_emoji} -> ${message.reaction_to_id}]`);
  }

  const bodySegments = [];
  const displayText = cleanText(message.display_text || message.text);
  if (displayText) bodySegments.push(displayText);

  if (message.media_type || message.filename || message.media_caption) {
    const mediaMeta = [
      message.media_type,
      message.filename ? `filename=${message.filename}` : null,
      message.mime_type ? `mime=${message.mime_type}` : null,
      message.media_caption ? `caption="${cleanText(message.media_caption)}"` : null,
    ].filter(Boolean).join(' ');
    bodySegments.push(`[MEDIA ${mediaMeta}]`);
  }

  return `${parts.join(' ')} ${bodySegments.join(' ')}`.trim();
}

async function callModel(chat, promptText) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://railway-wacli-worker.local',
      'X-Title': 'rfq-ai-worker',
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            `account_key: ${chat.account_key}`,
            `chat_jid: ${chat.chat_jid}`,
            'conversation_window:',
            promptText,
          ].join('\n'),
        },
      ],
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message || body?.message || response.statusText;
    throw new Error(`OpenRouter request failed: ${message}`);
  }

  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenRouter returned an empty message content');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Model output was not valid JSON: ${error.message}`);
  }

  return {
    output: parsed,
    usage: {
      prompt_tokens: numberOrZero(body?.usage?.prompt_tokens),
      completion_tokens: numberOrZero(body?.usage?.completion_tokens),
      total_tokens: numberOrZero(body?.usage?.total_tokens),
    },
  };
}

function sanitizeModelOutput(output, windowMessages) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('Model output must be a JSON object');
  }

  const rfqs = Array.isArray(output.rfqs) ? output.rfqs : [];
  const idToMsgId = new Map();
  const msgIdToId = new Map();

  for (const message of windowMessages) {
    if (message.id) idToMsgId.set(message.id, message.msg_id);
    if (message.msg_id) msgIdToId.set(message.msg_id, message.id);
  }

  const validMessageIds = new Set(idToMsgId.keys());
  const validMsgIds = new Set(msgIdToId.keys());
  const sanitized = [];

  for (const item of rfqs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    const summary = cleanText(item.summary);
    if (!summary) continue;

    const extractionType = item.extraction_type === 'rfq' ? 'rfq' : null;
    if (!extractionType) continue;

    let sourceMessageIds = ensureStringArray(item.source_message_ids).filter((value) => validMessageIds.has(value));
    let sourceMsgIds = ensureStringArray(item.source_msg_ids).filter((value) => validMsgIds.has(value));

    if (sourceMessageIds.length === 0 && sourceMsgIds.length > 0) {
      sourceMessageIds = unique(
        sourceMsgIds.map((msgId) => msgIdToId.get(msgId)).filter(Boolean)
      );
    }

    if (sourceMsgIds.length === 0 && sourceMessageIds.length > 0) {
      sourceMsgIds = unique(
        sourceMessageIds.map((messageId) => idToMsgId.get(messageId)).filter(Boolean)
      );
    }

    if (sourceMessageIds.length === 0) continue;

    const extractedJson = mergeExtractedJson(item.extracted_json);
    extractedJson.booking_status = normalizeBookingStatus(extractedJson.booking_status);
    extractedJson.booking_status_confidence = clamp01(extractedJson.booking_status_confidence);

    sanitized.push({
      summary,
      extraction_type: 'rfq',
      confidence: clamp01(item.confidence),
      source_message_ids: sourceMessageIds,
      source_msg_ids: sourceMsgIds,
      extracted_json: extractedJson,
    });
  }

  return { rfqs: sanitized };
}

function mergeExtractedJson(value) {
  const extractedJson = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...DEFAULT_EXTRACTED_JSON,
    ...extractedJson,
  };
}

async function insertAiExtractionRun(payload) {
  const { data, error } = await supabase.rpc('insert_ai_extraction_run', {
    p_account_key: payload.account_key,
    p_chat_jid: payload.chat_jid,
    p_window_start_at: payload.window_start_at,
    p_window_end_at: payload.window_end_at,
    p_source_message_ids: payload.source_message_ids,
    p_source_msg_ids: payload.source_msg_ids,
    p_candidate_reason: payload.candidate_reason,
    p_status: payload.status,
    p_error: payload.error,
    p_model: payload.model,
    p_prompt_tokens: payload.prompt_tokens,
    p_completion_tokens: payload.completion_tokens,
    p_total_tokens: payload.total_tokens,
    p_dry_run: payload.dry_run,
  });

  if (error) {
    throw new Error(`insert_ai_extraction_run failed: ${error.message}`);
  }

  return data;
}

async function insertRfqExtractions(chat, runId, rfqs) {
  const { data, error } = await supabase.rpc('insert_rfq_extractions', {
    p_account_key: chat.account_key,
    p_chat_jid: chat.chat_jid,
    p_extraction_run_id: runId,
    p_rfqs: rfqs,
    p_dry_run: DRY_RUN,
  });

  if (error) {
    throw new Error(`insert_rfq_extractions failed: ${error.message}`);
  }

  return data?.[0] || { inserted_count: 0, skipped_count: 0 };
}

async function completeChatProcessing(chat, processedMessageAt, processedMessageId) {
  const { error } = await supabase.rpc('complete_chat_processing', {
    p_account_key: chat.account_key,
    p_chat_jid: chat.chat_jid,
    p_processed_message_at: processedMessageAt,
    p_processed_message_id: processedMessageId,
  });

  if (error) {
    throw new Error(`complete_chat_processing failed: ${error.message}`);
  }
}

async function failChatProcessing(chat, message) {
  const { error } = await supabase.rpc('fail_chat_processing', {
    p_account_key: chat.account_key,
    p_chat_jid: chat.chat_jid,
    p_error: message,
  });

  if (error) {
    throw new Error(`fail_chat_processing failed: ${error.message}`);
  }
}

function normalizeBookingStatus(value) {
  return ['booked', 'not_booked', 'unknown'].includes(value) ? value : 'unknown';
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function ensureStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (number < 0) return 0;
  if (number > 1) return 1;
  return number;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function unique(values) {
  return Array.from(new Set(values));
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function logChat(chat, fields) {
  console.log(JSON.stringify({
    level: fields.status === 'error' ? 'error' : 'info',
    msg: 'chat processed',
    account_key: chat.account_key,
    chat_jid: chat.chat_jid,
    ...fields,
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(JSON.stringify({
    level: 'fatal',
    msg: 'worker crashed',
    error: error.message,
    stack: error.stack,
  }));
  process.exit(1);
});
