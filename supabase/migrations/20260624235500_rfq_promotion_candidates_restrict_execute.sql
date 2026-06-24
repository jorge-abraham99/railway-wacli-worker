revoke all on function public.get_rfq_promotion_candidates(integer, numeric) from public, anon, authenticated;
grant execute on function public.get_rfq_promotion_candidates(integer, numeric) to service_role;
