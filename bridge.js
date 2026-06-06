import Fastify from 'fastify';
import crypto from 'node:crypto';
import {
  createSupabaseClient,
  getAccountKey,
  normalizeWebhook,
  supabaseErrorFields,
  upsertChat,
  upsertMessage,
} from './wa-ingest.js';

const app = Fastify({
  logger: true,
  bodyLimit: 20 * 1024 * 1024,
});

const supabase = createSupabaseClient();
const ACCOUNT_KEY = getAccountKey();
const WEBHOOK_SECRET = process.env.WACLI_WEBHOOK_SECRET || '';

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

  const message = normalizeWebhook(request.body, ACCOUNT_KEY);

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

  const { error: chatError } = await upsertChat(supabase, message);

  if (chatError) {
    request.log.error(
      supabaseErrorFields(chatError, message),
      'Failed to upsert chat'
    );

    return reply.code(500).send({
      ok: false,
      error: chatError.message,
    });
  }

  const { error } = await upsertMessage(supabase, message);

  if (error) {
    request.log.error(
      supabaseErrorFields(error, message),
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
