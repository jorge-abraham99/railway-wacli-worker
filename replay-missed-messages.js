import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  createSupabaseClient,
  getAccountKey,
  normalizeStoredMessageRow,
  supabaseErrorFields,
  timestampToNumber,
  upsertChat,
  upsertMessage,
} from './wa-ingest.js';

const execFileAsync = promisify(execFile);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = await loadStoredMessages(options);
  const supabase = options.dryRun && !hasSupabaseEnv()
    ? null
    : createSupabaseClient();

  const summary = {
    step: 'replay_missed_messages',
    dry_run: options.dryRun,
    db_path: options.dbPath,
    after: options.after || null,
    before: options.before || null,
    chat: options.chat || null,
    limit: options.limit,
    scanned: rows.length,
    replayed: 0,
    failed: 0,
    skipped_missing_identity: 0,
  };

  for (const row of rows) {
    const message = normalizeStoredMessageRow(row, options.accountKey);

    if (!message.chat_jid || !message.msg_id) {
      summary.skipped_missing_identity += 1;
      console.warn(JSON.stringify({
        level: 'warn',
        step: 'replay_skip_missing_identity',
        sqlite_rowid: row.sqlite_rowid,
        chat_jid: message.chat_jid,
        msg_id: message.msg_id,
      }));
      continue;
    }

    if (options.dryRun) {
      summary.replayed += 1;
      continue;
    }

    const { error: chatError } = await upsertChat(supabase, message);
    if (chatError) {
      summary.failed += 1;
      console.error(JSON.stringify({
        level: 'error',
        step: 'replay_upsert_chat_failed',
        ...supabaseErrorFields(chatError, message),
      }));
      continue;
    }

    const { error } = await upsertMessage(supabase, message);
    if (error) {
      summary.failed += 1;
      console.error(JSON.stringify({
        level: 'error',
        step: 'replay_upsert_message_failed',
        ...supabaseErrorFields(error, message),
      }));
      continue;
    }

    summary.replayed += 1;
  }

  console.log(JSON.stringify({
    level: 'info',
    ...summary,
  }));
}

async function loadStoredMessages(options) {
  const columns = await getMessagesColumns(options.dbPath);
  const query = buildMessagesQuery(columns, options);
  const rows = await readSqliteJson(options.dbPath, query);
  return Array.isArray(rows) ? rows : [];
}

async function getMessagesColumns(dbPath) {
  const rows = await readSqliteJson(dbPath, 'pragma table_info(messages);');
  return new Set((rows || []).map((row) => row.name));
}

function buildMessagesQuery(columns, options) {
  const selectExprs = [
    'm.rowid as sqlite_rowid',
    columnExpr(columns, 'chat_jid'),
    chatNameExpr(columns),
    columnExpr(columns, 'msg_id'),
    columnExpr(columns, 'sender_jid'),
    columnExpr(columns, 'sender_name'),
    columnExpr(columns, 'from_me'),
    columnExpr(columns, 'ts', 'message_ts'),
    columnExpr(columns, 'text'),
    columnExpr(columns, 'display_text'),
    columnExpr(columns, 'quoted_msg_id'),
    columnExpr(columns, 'quoted_sender_jid'),
    columnExpr(columns, 'is_forwarded'),
    columnExpr(columns, 'forwarding_score'),
    columnExpr(columns, 'reaction_to_id'),
    columnExpr(columns, 'reaction_emoji'),
    columnExpr(columns, 'media_type'),
    columnExpr(columns, 'media_caption'),
    columnExpr(columns, 'filename'),
    columnExpr(columns, 'mime_type'),
    localPathExpr(columns),
    columnExpr(columns, 'downloaded_at'),
    columnExpr(columns, 'revoked'),
    columnExpr(columns, 'deleted_for_me'),
    columnExpr(columns, 'edited'),
    columnExpr(columns, 'edited_ts'),
    columnExpr(columns, 'raw'),
  ];

  const where = [];
  if (options.afterEpoch !== null) where.push(`m.ts >= ${options.afterEpoch}`);
  if (options.beforeEpoch !== null) where.push(`m.ts <= ${options.beforeEpoch}`);
  if (options.chat) where.push(`m.chat_jid = ${sqlString(options.chat)}`);

  const whereSql = where.length > 0 ? `where ${where.join(' and ')}` : '';

  return `
    select
      ${selectExprs.join(',\n      ')}
    from messages m
    left join chats c on c.jid = m.chat_jid
    ${whereSql}
    order by m.ts asc, m.rowid asc
    limit ${options.limit};
  `;
}

function columnExpr(columns, name, alias = name) {
  return columns.has(name) ? `m.${name} as ${alias}` : `null as ${alias}`;
}

function chatNameExpr(columns) {
  if (columns.has('chat_name')) {
    return `coalesce(m.chat_name, c.name, '') as chat_name`;
  }

  return `coalesce(c.name, '') as chat_name`;
}

function localPathExpr(columns) {
  if (columns.has('local_path')) return 'm.local_path as local_path';
  if (columns.has('direct_path')) return 'm.direct_path as local_path';
  return 'null as local_path';
}

async function readSqliteJson(dbPath, sql) {
  const { stdout, stderr } = await execFileAsync('sqlite3', [
    '-readonly',
    '-json',
    dbPath,
    sql,
  ]);

  if (stderr && stderr.trim()) {
    throw new Error(stderr.trim());
  }

  return stdout.trim() ? JSON.parse(stdout) : [];
}

function parseArgs(argv) {
  const options = {
    accountKey: getAccountKey(),
    storeDir: process.env.WACLI_STORE_DIR || '/data/wacli',
    dbPath: null,
    after: null,
    before: null,
    afterEpoch: null,
    beforeEpoch: null,
    chat: null,
    limit: 5000,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--after':
        options.after = requireValue(arg, next);
        options.afterEpoch = requireTimestamp(arg, options.after);
        i += 1;
        break;
      case '--before':
        options.before = requireValue(arg, next);
        options.beforeEpoch = requireTimestamp(arg, options.before);
        i += 1;
        break;
      case '--chat':
        options.chat = requireValue(arg, next);
        i += 1;
        break;
      case '--limit':
        options.limit = requireLimit(requireValue(arg, next));
        i += 1;
        break;
      case '--store-dir':
        options.storeDir = requireValue(arg, next);
        i += 1;
        break;
      case '--db-path':
        options.dbPath = requireValue(arg, next);
        i += 1;
        break;
      case '--account-key':
        options.accountKey = requireValue(arg, next);
        i += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.dbPath = options.dbPath || path.join(options.storeDir, 'wacli.db');

  if (options.afterEpoch !== null && options.beforeEpoch !== null && options.afterEpoch > options.beforeEpoch) {
    throw new Error('--after must be earlier than or equal to --before');
  }

  return options;
}

function requireValue(flag, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function requireTimestamp(flag, value) {
  const ts = timestampToNumber(value);
  if (ts === null) {
    throw new Error(`${flag} must be a valid RFC3339 timestamp or unix timestamp`);
  }

  return ts;
}

function requireLimit(value) {
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('--limit must be a positive integer');
  }

  return limit;
}

function sqlString(value) {
  return `'${String(value).replaceAll('\'', '\'\'')}'`;
}

function hasSupabaseEnv() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function printHelp() {
  console.log(`Usage:
  node replay-missed-messages.js --after <RFC3339> --before <RFC3339> [--chat <jid>] [--limit <n>] [--dry-run]

Examples:
  node replay-missed-messages.js --after "2026-06-04T10:10:39.006575Z" --before "2026-06-06T13:00:00Z" --dry-run
  node replay-missed-messages.js --after "2026-06-04T10:10:39.006575Z" --before "2026-06-06T13:00:00Z"
  node replay-missed-messages.js --chat "194300545601653@lid" --after "2026-06-06T13:00:00Z" --before "2026-06-06T14:00:00Z"

Options:
  --after        Inclusive lower bound, RFC3339 or unix timestamp
  --before       Inclusive upper bound, RFC3339 or unix timestamp
  --chat         Restrict replay to one chat JID
  --limit        Max rows to replay, default 5000
  --store-dir    wacli store directory, default $WACLI_STORE_DIR or /data/wacli
  --db-path      Override exact wacli.db path
  --account-key  Override account_key written to Supabase
  --dry-run      Read and count rows without writing to Supabase
`);
}

main().catch((error) => {
  console.error(JSON.stringify({
    level: 'error',
    step: 'replay_missed_messages_failed',
    error: error.message,
  }));
  process.exitCode = 1;
});
