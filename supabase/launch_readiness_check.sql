-- =====================================================================
-- launch_readiness_check.sql  -  READ-ONLY, safe to run any time.
--
-- Paste the whole file into the Supabase SQL Editor and press Run. It
-- changes nothing: every line is a SELECT. The result is one table of
-- checks - each row says OK, ACTION (fix before launch) or INFO.
--
-- The one helper below lives in pg_temp, so it disappears when the query
-- finishes. It lets the checks look at optional features (cron, vault)
-- without the whole script failing when one of them isn't installed.
-- =====================================================================

CREATE OR REPLACE FUNCTION pg_temp.try_text(p_sql text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_result text;
BEGIN
  EXECUTE p_sql INTO v_result;
  RETURN v_result;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

WITH facts AS (
  SELECT
    -- Migrations 0021-0027
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'department') AS m0021,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'open_for_claim') AS m0022,
    EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = 'user_role' AND e.enumlabel = 'operator') AS m0023,
    EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'release_ticket_to_pool') AS m0024,
    EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'staff_log_ticket' AND pronargs = 11) AS m0025,
    EXISTS (SELECT 1 FROM pg_policies
            WHERE tablename = 'ticket_attachments'
              AND policyname = 'Uploader or admin deletes attachment'
              AND qual NOT LIKE '%service_receipt%') AS m0026,
    coalesce(pg_temp.try_text(
      $q$SELECT (pg_get_functiondef('public.queue_ticket_notification'::regproc) LIKE '%role <> ''customer''%')::text$q$
    ), 'false')::boolean AS m0027,

    -- Email pipeline
    EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') AS has_pg_net,
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_send_notifications' AND NOT tgisinternal) AS has_instant_trigger,
    pg_temp.try_text($q$SELECT count(*)::text FROM vault.secrets WHERE name = 'absl_worker_secret'$q$) AS vault_secret_count,
    pg_temp.try_text($q$SELECT count(*)::text FROM cron.job WHERE command ILIKE '%send-notifications%' AND active$q$) AS cron_job_count,
    (SELECT count(*) FROM public.notifications WHERE status = 'sent') AS sent_count,
    (SELECT count(*) FROM public.notifications WHERE status IN ('pending', 'retry')) AS waiting_count,
    (SELECT count(*) FROM public.notifications WHERE status = 'dead_letter') AS dead_count,
    (SELECT max(sent_at) FROM public.notifications WHERE status = 'sent') AS last_sent_at,
    (SELECT left(error_message, 160) FROM public.notifications
      WHERE status IN ('retry', 'dead_letter') AND error_message IS NOT NULL
      ORDER BY created_at DESC LIMIT 1) AS last_error,

    -- Accounts
    (SELECT count(*) FROM public.profiles WHERE role = 'admin' AND approval_status = 'approved') AS admin_count,
    (SELECT count(*) FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id WHERE p.id IS NULL) AS users_without_profile,
    (SELECT count(*) FROM auth.users WHERE email_confirmed_at IS NULL) AS unconfirmed_users,
    (SELECT count(*) FROM auth.users) AS total_users,
    (SELECT string_agg(domain, ', ' ORDER BY domain) FROM public.company_domains WHERE auto_approve) AS auto_approve_domains,

    -- Storage and realtime
    (SELECT string_agg(id, ', ' ORDER BY id) FROM storage.buckets
      WHERE public AND id IN ('ticket-photos', 'ticket-voice-notes', 'ticket-videos',
                              'ticket-service-receipts', 'inventory-csv-imports')) AS public_buckets,
    (SELECT string_agg(tablename, ', ' ORDER BY tablename) FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND tablename IN ('tickets', 'ticket_comments', 'admin_alerts')) AS realtime_tables
),
checks AS (
  SELECT 1 AS n, 'Migrations 0021-0027 applied' AS "check",
    CASE WHEN m0021 AND m0022 AND m0023 AND m0024 AND m0025 AND m0026 AND m0027 THEN 'OK' ELSE 'ACTION' END AS status,
    'missing: ' || coalesce(nullif(concat_ws(', ',
      CASE WHEN NOT m0021 THEN '0021' END, CASE WHEN NOT m0022 THEN '0022' END,
      CASE WHEN NOT m0023 THEN '0023' END, CASE WHEN NOT m0024 THEN '0024' END,
      CASE WHEN NOT m0025 THEN '0025' END, CASE WHEN NOT m0026 THEN '0026' END,
      CASE WHEN NOT m0027 THEN '0027' END), ''), 'none') AS detail
  FROM facts
  UNION ALL
  SELECT 2, 'At least one approved CEO/admin account',
    CASE WHEN admin_count > 0 THEN 'OK' ELSE 'ACTION' END,
    admin_count || ' approved admin account(s)'
  FROM facts
  UNION ALL
  SELECT 3, 'Every login has a profile',
    CASE WHEN users_without_profile = 0 THEN 'OK' ELSE 'ACTION' END,
    users_without_profile || ' login(s) with no profile row'
  FROM facts
  UNION ALL
  SELECT 4, 'Emails actually sending',
    CASE WHEN sent_count > 0 AND dead_count = 0 THEN 'OK'
         WHEN sent_count = 0 AND dead_count = 0 AND waiting_count = 0 THEN 'INFO'
         ELSE 'ACTION' END,
    sent_count || ' sent, ' || waiting_count || ' waiting, ' || dead_count || ' failed for good'
      || coalesce('; last sent ' || to_char(last_sent_at, 'YYYY-MM-DD HH24:MI'), '')
      || coalesce('; latest error: ' || last_error, '')
  FROM facts
  UNION ALL
  SELECT 5, 'Instant email trigger (0020)',
    CASE WHEN has_pg_net AND has_instant_trigger THEN 'OK' ELSE 'ACTION' END,
    'pg_net ' || CASE WHEN has_pg_net THEN 'on' ELSE 'OFF' END
      || ', trigger ' || CASE WHEN has_instant_trigger THEN 'present' ELSE 'MISSING' END
  FROM facts
  UNION ALL
  SELECT 6, 'Worker secret stored in Vault',
    CASE WHEN coalesce(vault_secret_count, '0') <> '0' THEN 'OK' ELSE 'ACTION' END,
    CASE WHEN vault_secret_count IS NULL THEN 'could not read vault'
         WHEN vault_secret_count = '0' THEN 'absl_worker_secret not found - instant sends are refused until it exists'
         ELSE 'absl_worker_secret present' END
  FROM facts
  UNION ALL
  SELECT 7, '5-minute retry cron for emails',
    CASE WHEN coalesce(cron_job_count, '0') <> '0' THEN 'OK' ELSE 'ACTION' END,
    CASE WHEN cron_job_count IS NULL THEN 'pg_cron not enabled (fine only if an outside scheduler calls send-notifications)'
         WHEN cron_job_count = '0' THEN 'no active cron job calls send-notifications'
         ELSE cron_job_count || ' active job(s)' END
  FROM facts
  UNION ALL
  SELECT 8, 'File buckets are private',
    CASE WHEN public_buckets IS NULL THEN 'OK' ELSE 'ACTION' END,
    coalesce('PUBLIC: ' || public_buckets, 'all ticket buckets private')
  FROM facts
  UNION ALL
  SELECT 9, 'Live updates (realtime) on',
    CASE WHEN realtime_tables = 'admin_alerts, ticket_comments, tickets' THEN 'OK' ELSE 'ACTION' END,
    'enabled for: ' || coalesce(realtime_tables, 'none')
  FROM facts
  UNION ALL
  SELECT 10, 'Unverified logins', 'INFO',
    unconfirmed_users || ' of ' || total_users || ' logins have not verified their email'
  FROM facts
  UNION ALL
  SELECT 11, 'Auto-approved email domains', 'INFO',
    coalesce(auto_approve_domains, 'none') || ' - customers on these domains get in without review'
  FROM facts
)
SELECT "check", status, detail
FROM checks
ORDER BY CASE status WHEN 'ACTION' THEN 0 WHEN 'INFO' THEN 2 ELSE 1 END, n;
