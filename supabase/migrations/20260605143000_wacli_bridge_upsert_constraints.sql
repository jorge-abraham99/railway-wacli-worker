do $$
begin
  if to_regclass('public.wa_chats') is not null then
    create unique index if not exists wa_chats_account_chat_uidx
      on public.wa_chats (account_key, chat_jid);
  end if;

  if to_regclass('public.wa_messages') is not null then
    create unique index if not exists wa_messages_account_chat_msg_uidx
      on public.wa_messages (account_key, chat_jid, msg_id);
  end if;
end;
$$;
