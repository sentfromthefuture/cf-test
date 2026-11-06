-- Fixes dr_requeue_heuristic_analysis: the first version left the keyword-based signal rows in place, so they were immediately
-- re-clustered by title similarity and the later AI analysis could not re-cluster them with embeddings.
-- Now the keyword-based signals are deleted (they are re-created by the next analysis pass), and records that were permanently
-- marked 'failed' are re-queued as well.
create or replace function public.dr_requeue_heuristic_analysis(p_limit integer default 2000)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare v_ids uuid[]; v_clusters uuid[]; v_n integer;
begin
  select coalesce(array_agg(record_id), '{}') into v_ids from (
    select record_id from public.dr_problem_signals where analysis_method = 'heuristic' order by analyzed_at limit least(greatest(p_limit, 1), 20000)) t;
  v_n := cardinality(v_ids);

  perform pg_advisory_xact_lock(hashtext('dr_assign_cluster'));
  if v_n > 0 then
    select coalesce(array_agg(distinct cluster_id), '{}') into v_clusters from public.dr_cluster_members where record_id = any (v_ids);
    delete from public.dr_cluster_members where record_id = any (v_ids);
    delete from public.dr_problem_signals where record_id = any (v_ids);
    update public.dr_clusters set stats_dirty = true, summary_dirty = true, updated_at = now() where id = any (v_clusters);
    delete from public.dr_clusters c where c.id = any (v_clusters)
      and not exists (select 1 from public.dr_cluster_members m where m.cluster_id = c.id);
    update public.dr_raw_records set analysis_status = 'pending', analysis_attempts = 0 where id = any (v_ids);
  end if;

  -- records that exhausted their attempts earlier get another chance
  update public.dr_raw_records set analysis_status = 'pending', analysis_attempts = 0 where analysis_status = 'failed';
  return v_n;
end $$;

revoke all on function public.dr_requeue_heuristic_analysis(integer) from public, anon, authenticated;
grant execute on function public.dr_requeue_heuristic_analysis(integer) to service_role;
