-- Invalid model output is input-specific, but a one-hour cooldown makes recovery impractical
-- when a model returns fenced/prefaced JSON or a schema-incompatible answer. Keep service-level
-- failures on the existing exponential backoff; allow invalid-response inputs to retry after 60s.
CREATE OR REPLACE FUNCTION public.dr_ai_cache_fail(
  p_id uuid,
  p_epoch bigint,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  n integer;
  v_retry interval;
BEGIN
  IF coalesce(p_reason, '') LIKE 'invalid_response:%' THEN
    v_retry := interval '1 minute';
  ELSE
    v_retry := make_interval(hours => least(168, (2 ^ least((SELECT failed_attempts FROM public.dr_ai_cache WHERE id = p_id), 8))::integer));
  END IF;

  UPDATE public.dr_ai_cache
     SET status = 'failed',
         failure_kind = 'input',
         result = NULL,
         lease_until = NULL,
         retry_after = now() + v_retry,
         failed_attempts = failed_attempts + 1,
         last_failure = left(coalesce(p_reason, 'failed'), 200)
   WHERE id = p_id
     AND status = 'pending'
     AND lease_epoch = p_epoch;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$function$;
