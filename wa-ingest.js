import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

export function getAccountKey() {
  return process.env.WACLI_ACCOUNT_KEY || 'default';
}

export function createSupabaseClient() {
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

export function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

export function boolValue(value) {
  if (value === true || value === 1 || value === '1') return true;
  return false;
}

export function nullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function timestampToIso(ts) {
  if (!ts) return null;

  if (typeof ts === 'string') {
    const parsed = new Date(ts);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  const n = Number(ts);
  if (!Number.isFinite(n)) return null;

  const ms = n < 10_000_000_000 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

export function timestampToNumber(ts) {
  if (!ts) return null;

  if (typeof ts === 'number') return ts;

  if (typeof ts === 'string') {
    const asNumber = Number(ts);
    if (Number.isFinite(asNumber)) return asNumber;

    const parsed = new Date(ts);
    if (!Number.isNaN(parsed.getTime())) {
      return Math.floor(parsed.getTime() / 1000);
    }
  }

  return null;
}

export function normalizeWebhook(payload, accountKey = getAccountKey()) {
  const p = payload.message || payload.data || payload;
  const media = p.Media || p.media || null;
  const ts = firstDefined(
    p.ts,
    p.timestamp,
    p.Timestamp,
    p.message_timestamp,
    p.messageTimestamp
  );

  return {
    account_key: accountKey,
    sqlite_rowid: firstDefined(p.rowid, p.sqlite_rowid),
    chat_jid: firstDefined(
      p.chat_jid,
      p.chatJid,
      p.Chat,
      p.chat,
      p.remote_jid,
      p.remoteJid
    ),
    chat_name: firstDefined(p.chat_name, p.chatName, p.ChatName),
    msg_id: firstDefined(
      p.msg_id,
      p.message_id,
      p.messageId,
      p.ID,
      p.Id,
      p.id
    ),
    sender_jid: firstDefined(
      p.sender_jid,
      p.senderJid,
      p.SenderJID,
      p.sender
    ),
    sender_name: firstDefined(
      p.sender_name,
      p.senderName,
      p.PushName,
      p.push_name,
      p.pushName
    ),
    from_me: boolValue(firstDefined(p.from_me, p.fromMe, p.FromMe, false)),
    message_ts: timestampToNumber(ts),
    message_at: timestampToIso(ts),
    text: firstDefined(p.text, p.Text, p.body, p.Body),
    display_text: firstDefined(
      p.display_text,
      p.displayText,
      p.Text,
      p.text,
      p.Body,
      p.body,
      p.Media?.Caption,
      p.media?.caption
    ),
    quoted_msg_id: firstDefined(p.quoted_msg_id, p.quotedMsgId, p.ReplyToID),
    quoted_sender_jid: firstDefined(
      p.quoted_sender_jid,
      p.quotedSenderJid,
      p.ReplyToSenderJID
    ),
    is_forwarded: boolValue(firstDefined(p.is_forwarded, p.isForwarded, p.IsForwarded, false)),
    forwarding_score: nullableNumber(
      firstDefined(p.forwarding_score, p.forwardingScore, p.ForwardingScore, 0)
    ) || 0,
    reaction_to_id: firstDefined(p.reaction_to_id, p.reactionToId, p.ReactionToID),
    reaction_emoji: firstDefined(p.reaction_emoji, p.reactionEmoji, p.ReactionEmoji),
    media_type: firstDefined(p.media_type, p.mediaType, media?.Type),
    media_caption: firstDefined(p.media_caption, p.mediaCaption, media?.Caption),
    filename: firstDefined(p.filename, p.file_name, p.fileName, media?.Filename),
    mime_type: firstDefined(p.mime_type, p.mimeType, media?.MIMEType),
    local_path: firstDefined(p.local_path, p.localPath, media?.LocalPath),
    downloaded_at: timestampToIso(firstDefined(p.downloaded_at, p.downloadedAt, media?.DownloadedAt)),
    revoked: boolValue(firstDefined(p.revoked, p.Revoked, false)),
    deleted_for_me: boolValue(firstDefined(p.deleted_for_me, p.deletedForMe, false)),
    edited: boolValue(firstDefined(p.edited, p.Edited, false)),
    edited_ts: nullableNumber(firstDefined(p.edited_ts, p.editedTs, p.EditedTimestamp, 0)) || 0,
    raw: payload,
  };
}

export function normalizeStoredMessageRow(row, accountKey = getAccountKey()) {
  const ts = firstDefined(row.message_ts, row.ts, row.message_at);
  const raw = parseJsonObject(row.raw) || buildStoredRawPayload(row, ts);

  return {
    account_key: accountKey,
    sqlite_rowid: nullableNumber(row.sqlite_rowid),
    chat_jid: firstDefined(row.chat_jid),
    chat_name: firstDefined(row.chat_name),
    msg_id: firstDefined(row.msg_id),
    sender_jid: firstDefined(row.sender_jid),
    sender_name: firstDefined(row.sender_name),
    from_me: boolValue(row.from_me),
    message_ts: timestampToNumber(ts),
    message_at: timestampToIso(ts),
    text: firstDefined(row.text),
    display_text: firstDefined(row.display_text, row.text, row.media_caption),
    quoted_msg_id: firstDefined(row.quoted_msg_id),
    quoted_sender_jid: firstDefined(row.quoted_sender_jid),
    is_forwarded: boolValue(row.is_forwarded),
    forwarding_score: nullableNumber(row.forwarding_score) || 0,
    reaction_to_id: firstDefined(row.reaction_to_id),
    reaction_emoji: firstDefined(row.reaction_emoji),
    media_type: firstDefined(row.media_type),
    media_caption: firstDefined(row.media_caption),
    filename: firstDefined(row.filename),
    mime_type: firstDefined(row.mime_type),
    local_path: firstDefined(row.local_path, row.direct_path),
    downloaded_at: timestampToIso(firstDefined(row.downloaded_at)),
    revoked: boolValue(row.revoked),
    deleted_for_me: boolValue(row.deleted_for_me),
    edited: boolValue(row.edited),
    edited_ts: nullableNumber(row.edited_ts) || 0,
    raw,
  };
}

export function buildChatUpsert(message) {
  return {
    account_key: message.account_key,
    chat_jid: message.chat_jid,
    chat_name: message.chat_name,
    last_message_ts: message.message_ts,
    last_message_at: message.message_at,
    raw: message.raw,
    updated_at: new Date().toISOString(),
  };
}

export function supabaseErrorFields(error, message) {
  return {
    supabase_error_message: error?.message,
    supabase_error_code: error?.code,
    supabase_error_details: error?.details,
    supabase_error_hint: error?.hint,
    normalized_message: message,
  };
}

export async function upsertChat(supabase, message) {
  return supabase
    .from('wa_chats')
    .upsert(buildChatUpsert(message), {
      onConflict: 'account_key,chat_jid',
    });
}

export async function upsertMessage(supabase, message) {
  const upsertResult = await supabase
    .from('wa_messages')
    .upsert(message, {
      onConflict: 'account_key,chat_jid,msg_id',
    });

  if (!upsertResult.error || !isMissingConflictConstraint(upsertResult.error)) {
    return upsertResult;
  }

  const { data: existingMessage, error: selectError } = await supabase
    .from('wa_messages')
    .select('id')
    .eq('account_key', message.account_key)
    .eq('chat_jid', message.chat_jid)
    .eq('msg_id', message.msg_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selectError) {
    return {
      error: {
        ...selectError,
        message: `message conflict fallback select failed after upsert failed: ${selectError.message}`,
        details: {
          message: upsertResult.error.message,
          code: upsertResult.error.code,
          details: upsertResult.error.details,
          hint: upsertResult.error.hint,
        },
      },
    };
  }

  if (existingMessage?.id) {
    return supabase
      .from('wa_messages')
      .update(message)
      .eq('id', existingMessage.id);
  }

  return supabase
    .from('wa_messages')
    .insert(message);
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function buildStoredRawPayload(row, ts) {
  return {
    source: 'wacli.db.replay',
    rowid: nullableNumber(row.sqlite_rowid),
    Chat: firstDefined(row.chat_jid),
    ChatName: firstDefined(row.chat_name),
    ID: firstDefined(row.msg_id),
    SenderJID: firstDefined(row.sender_jid),
    PushName: firstDefined(row.sender_name),
    Timestamp: timestampToIso(ts),
    FromMe: boolValue(row.from_me),
    Text: firstDefined(row.text),
    DisplayText: firstDefined(row.display_text, row.text, row.media_caption),
    ReplyToID: firstDefined(row.quoted_msg_id),
    ReplyToSenderJID: firstDefined(row.quoted_sender_jid),
    IsForwarded: boolValue(row.is_forwarded),
    ForwardingScore: nullableNumber(row.forwarding_score) || 0,
    ReactionToID: firstDefined(row.reaction_to_id),
    ReactionEmoji: firstDefined(row.reaction_emoji),
    Media: firstDefined(row.media_type, row.media_caption, row.filename, row.mime_type, row.local_path)
      ? {
          Type: firstDefined(row.media_type),
          Caption: firstDefined(row.media_caption),
          Filename: firstDefined(row.filename),
          MIMEType: firstDefined(row.mime_type),
          LocalPath: firstDefined(row.local_path, row.direct_path),
        }
      : null,
    Revoked: boolValue(row.revoked),
    DeletedForMe: boolValue(row.deleted_for_me),
    Edited: boolValue(row.edited),
    EditedTimestamp: nullableNumber(row.edited_ts) || 0,
  };
}

function isMissingConflictConstraint(error) {
  return (
    error?.code === '42P10' ||
    /no unique or exclusion constraint/i.test(error?.message || '')
  );
}
