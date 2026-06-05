import Fastify from 'fastify';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const app = Fastify({
  logger: true,
  bodyLimit: 20 * 1024 * 1024,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: ws,
    },
  }
);

const ACCOUNT_KEY = process.env.WACLI_ACCOUNT_KEY || 'default';
const WEBHOOK_SECRET = process.env.WACLI_WEBHOOK_SECRET || '';

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function boolValue(value) {
  if (value === true || value === 1 || value === '1') return true;
  return false;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestampToIso(value) {
  if (value === undefined || value === null || value === '') return null;

  if (typeof value === 'string' && value.trim() !== '' && Number.isNaN(Number(value))) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  const n = nullableNumber(value);
  if (n === null) return null;

  const ms = Math.abs(n) < 10_000_000_000 ? n * 1000 : n;
  const parsed = new Date(ms);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function supabaseErrorDetails(error) {
  if (!error) return null;

  return {
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
  };
}

function isMissingConflictConstraint(error) {
  return (
    error?.code === '42P10' ||
    /no unique or exclusion constraint/i.test(error?.message || '')
  );
}

function verifySignature(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET) return true;

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expected =
    'sha256=' +
    crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signatureHeader)
    );
  } catch {
    return false;
  }
}

function normalizeWebhook(payload) {
  const p = payload.message || payload.data || payload;

  const chatJid = firstDefined(
    p.chat_jid,
    p.chatJid,
    p.Chat,
    p.chat,
    p.remote_jid,
    p.remoteJid
  );

  const msgId = firstDefined(
    p.msg_id,
    p.message_id,
    p.messageId,
    p.ID,
    p.Id,
    p.id
  );

  const senderJid = firstDefined(
    p.sender_jid,
    p.senderJid,
    p.SenderJID,
    p.sender
  );

  const senderName = firstDefined(
    p.sender_name,
    p.senderName,
    p.PushName,
    p.push_name,
    p.pushName
  );

  const ts = firstDefined(
    p.ts,
    p.timestamp,
    p.Timestamp,
    p.message_timestamp,
    p.messageTimestamp
  );

  const text = firstDefined(
    p.text,
    p.Text,
    p.body,
    p.Body
  );

  const media = p.Media || p.media || null;

  return {
    account_key: ACCOUNT_KEY,

    sqlite_rowid: firstDefined(p.rowid, p.sqlite_rowid),

    chat_jid: chatJid,
    chat_name: firstDefined(p.chat_name, p.chatName, p.ChatName),

    msg_id: msgId,

    sender_jid: senderJid,
    sender_name: senderName,

    from_me: boolValue(firstDefined(p.from_me, p.fromMe, p.FromMe, false)),

    message_ts: nullableNumber(ts),
    message_at: timestampToIso(ts),

    text,
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
    forwarding_score: nullableNumber(firstDefined(p.forwarding_score, p.forwardingScore, p.ForwardingScore, 0)) || 0,

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

async function upsertMessage(message) {
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
        details: supabaseErrorDetails(upsertResult.error),
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

app.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (request, body, done) => {
    request.rawBody = body;

    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (error) {
      done(error);
    }
  }
);

app.get('/health', async () => ({
  ok: true,
  account_key: ACCOUNT_KEY,
}));

app.post('/wacli', async (request, reply) => {
  const signature = request.headers['x-wacli-signature'];

  if (!verifySignature(request.rawBody, signature)) {
    request.log.warn('Invalid webhook signature');

    return reply.code(401).send({
      ok: false,
      error: 'Invalid signature',
    });
  }

  const message = normalizeWebhook(request.body);

  if (!message.chat_jid || !message.msg_id) {
    request.log.warn(
      {
        payload_type: Array.isArray(request.body) ? 'array' : typeof request.body,
        payload_keys:
          request.body && typeof request.body === 'object' && !Array.isArray(request.body)
            ? Object.keys(request.body)
            : null,
        payload_preview: JSON.stringify(request.body).slice(0, 2000),
      },
      'Skipping payload without chat_jid or msg_id'
    );

    return reply.code(202).send({
      ok: false,
      skipped: true,
      reason: 'Missing chat_jid or msg_id',
    });
  }

  const { error: chatError } = await supabase
    .from('wa_chats')
    .upsert(
      {
        account_key: ACCOUNT_KEY,
        chat_jid: message.chat_jid,
        chat_name: message.chat_name,
        last_message_ts: message.message_ts,
        last_message_at: message.message_at,
        raw: message.raw,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: 'account_key,chat_jid',
      }
    );

  if (chatError) {
    request.log.error({ error: supabaseErrorDetails(chatError) }, 'Failed to upsert chat');

    return reply.code(500).send({
      ok: false,
      error: chatError.message,
    });
  }

  const { error } = await upsertMessage(message);

  if (error) {
    request.log.error(
      {
        error: supabaseErrorDetails(error),
        chat_jid: message.chat_jid,
        msg_id: message.msg_id,
      },
      'Failed to upsert message'
    );

    return reply.code(500).send({
      ok: false,
      error: error.message,
    });
  }

  request.log.info(
    {
      chat_jid: message.chat_jid,
      msg_id: message.msg_id,
      text: message.display_text,
    },
    'Inserted WhatsApp message'
  );

  return {
    ok: true,
  };
});

const port = Number(process.env.PORT || 8787);

app.listen({
  port,
  host: '0.0.0.0',
});
