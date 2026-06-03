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

function timestampToIso(ts) {
  if (!ts) return null;

  const n = Number(ts);
  if (!Number.isFinite(n)) return null;

  const ms = n < 10_000_000_000 ? n * 1000 : n;
  return new Date(ms).toISOString();
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
    p.chat,
    p.remote_jid,
    p.remoteJid
  );

  const msgId = firstDefined(
    p.msg_id,
    p.message_id,
    p.messageId,
    p.id
  );

  const ts = firstDefined(
    p.ts,
    p.timestamp,
    p.message_timestamp,
    p.messageTimestamp
  );

  return {
    account_key: ACCOUNT_KEY,

    sqlite_rowid: firstDefined(p.rowid, p.sqlite_rowid),

    chat_jid: chatJid,
    chat_name: firstDefined(p.chat_name, p.chatName),

    msg_id: msgId,

    sender_jid: firstDefined(p.sender_jid, p.senderJid, p.sender),
    sender_name: firstDefined(
      p.sender_name,
      p.senderName,
      p.push_name,
      p.pushName
    ),

    from_me: boolValue(firstDefined(p.from_me, p.fromMe, false)),

    message_ts: ts ? Number(ts) : null,
    message_at: timestampToIso(ts),

    text: firstDefined(p.text, p.body),
    display_text: firstDefined(
      p.display_text,
      p.displayText,
      p.text,
      p.body,
      p.caption
    ),

    quoted_msg_id: firstDefined(p.quoted_msg_id, p.quotedMsgId),
    quoted_sender_jid: firstDefined(p.quoted_sender_jid, p.quotedSenderJid),

    is_forwarded: boolValue(firstDefined(p.is_forwarded, p.isForwarded, false)),
    forwarding_score: Number(firstDefined(p.forwarding_score, p.forwardingScore, 0)),

    reaction_to_id: firstDefined(p.reaction_to_id, p.reactionToId),
    reaction_emoji: firstDefined(p.reaction_emoji, p.reactionEmoji),

    media_type: firstDefined(p.media_type, p.mediaType),
    media_caption: firstDefined(p.media_caption, p.mediaCaption),
    filename: firstDefined(p.filename, p.file_name, p.fileName),
    mime_type: firstDefined(p.mime_type, p.mimeType),
    local_path: firstDefined(p.local_path, p.localPath),
    downloaded_at: firstDefined(p.downloaded_at, p.downloadedAt),

    revoked: boolValue(firstDefined(p.revoked, false)),
    deleted_for_me: boolValue(firstDefined(p.deleted_for_me, p.deletedForMe, false)),
    edited: boolValue(firstDefined(p.edited, false)),
    edited_ts: Number(firstDefined(p.edited_ts, p.editedTs, 0)),

    raw: payload,
  };
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
      { payload: request.body },
      'Skipping payload without chat_jid or msg_id'
    );

    return reply.code(202).send({
      ok: false,
      skipped: true,
      reason: 'Missing chat_jid or msg_id',
    });
  }

  const { error } = await supabase
    .from('wa_messages')
    .upsert(message, {
      onConflict: 'account_key,chat_jid,msg_id',
    });

  if (error) {
    request.log.error({ error }, 'Failed to upsert message');

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
