-- =====================================================================
-- diagnose.sql — read-only. Changes nothing. Run it any time.
--
-- Answers two questions:
--   1. Which migrations have actually taken effect?
--   2. Is there existing data that would stop 0004 from applying?
-- =====================================================================


-- 1. Which migrations are in place -------------------------------------
SELECT
  'migration status' AS check,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public')                  AS policies,
  (SELECT count(*) FROM pg_trigger  WHERE tgname = 'on_auth_user_created')        AS m0002_signup_trigger,
  (SELECT count(*) FROM pg_trigger  WHERE tgname = 'guard_profile_privileges')    AS m0003_guard,
  (SELECT count(*) FROM pg_proc     WHERE proname = 'admin_review_registration')  AS m0003_review_rpc,
  (SELECT count(*) FROM pg_proc     WHERE proname = 'reassign_ticket')            AS m0004_reassign,
  (SELECT count(*) FROM pg_proc     WHERE proname = 'request_callback')           AS m0004_callback,
  (SELECT count(*) FROM pg_views    WHERE viewname = 'staff_directory')           AS m0004_staff_view,
  (SELECT count(*) FROM pg_proc     WHERE proname = 'ticket_detail')              AS m0004_detail_rpc,
  (SELECT count(*) FROM information_schema.tables WHERE table_name = 'ticket_receipts') AS m0005_receipts_table,
  (SELECT count(*) FROM pg_proc     WHERE proname = 'generate_ticket_receipt')    AS m0005_receipt_trigger_fn,
  (SELECT pg_get_functiondef('public.queue_comment_notification'::regproc) LIKE '%assigned_technician_id%') AS m0006_reply_notify_fixed,
  (SELECT pg_get_functiondef('public.queue_comment_notification'::regproc) LIKE '%role IN (%agent%admin%') AS m0006_unassigned_reply_broadcast,
  (SELECT pg_get_functiondef('public.reassign_ticket'::regproc) LIKE '%claim an unassigned job for yourself%') AS m0006_claim_only_for_self,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'tickets' AND column_name = 'service_call_number')     AS m0007_service_call_column,
  (SELECT pg_get_functiondef('public.change_ticket_status'::regproc) LIKE '%service call number is required%') AS m0007_resolve_requires_receipt,
  (SELECT count(*) FROM information_schema.tables WHERE table_name = 'client_error_logs') AS m0008_client_error_log_table,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'tickets' AND column_name = 'resolution_notes')       AS m0009_resolution_notes_column,
  (SELECT count(*) FROM pg_proc WHERE proname = 'add_progress_photo')          AS m0009_progress_photo_rpc,
  (SELECT count(*) FROM pg_proc WHERE proname = 'report_search')              AS m0009_report_search_rpc,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'ticket_receipts' AND column_name = 'service_call_number') AS m0010_receipt_service_call_column,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'ticket_receipts' AND column_name = 'receipt_photo_path')   AS m0010_receipt_photo_column,
  (SELECT pg_get_functiondef('public.change_ticket_status'::regproc) NOT LIKE '%current_role() = ''technician''%') AS m0011_evidence_required_for_all_staff,
  (SELECT pg_get_functiondef('public.add_progress_photo'::regproc) LIKE '%IS DISTINCT FROM%') AS m0012_progress_photo_null_fixed,
  (SELECT pg_get_functiondef('public.report_search'::regproc) LIKE '%Asia/Colombo%') AS m0012_report_search_timezone_fixed,
  (SELECT count(*) FROM pg_policies
     WHERE tablename = 'ticket_attachments' AND policyname = 'Uploader or admin deletes attachment') AS m0013_attachment_delete_policy,
  (SELECT pg_get_functiondef('public.queue_ticket_notification'::regproc) LIKE '%What we did%') AS m0014_resolved_email_enriched,
  (SELECT pg_get_functiondef('public.admin_review_registration'::regproc) LIKE '%has been approved%') AS m0015_registration_decision_email;
-- Expect: policies 30+, every other column 1, and all three m0006_* columns = true.
-- Those have no separate object to count — 0006 only CREATE OR REPLACEs
-- existing functions — so the live functions' own source is the only proof.
-- (The claim_only_for_self and unassigned_reply_broadcast checks require the
-- amended 0006 from the follow-up review pass — re-run 0006 if either reads
-- false on a database where 0006 was already applied once before.)
-- Expect: policies 30+, and 1 in every other column.
-- A 0 in an m0004_ column means 0004 has not applied.


-- 2. Rows that would block 0004's constraints ---------------------------
-- Every count must be 0. Anything above 0 is data written before the rule
-- existed; 0004 now repairs these automatically, so this is only here to
-- show you what it will touch.
SELECT
  'blocking rows' AS check,
  (SELECT count(*) FROM public.tickets
     WHERE priority IS NULL OR priority NOT IN ('high','medium','low'))      AS bad_priority,
  (SELECT count(*) FROM public.tickets
     WHERE title IS NULL OR char_length(trim(title)) < 3)                    AS title_too_short,
  (SELECT count(*) FROM public.tickets
     WHERE char_length(title) > 200)                                        AS title_too_long,
  (SELECT count(*) FROM public.tickets
     WHERE description IS NULL OR trim(description) = '')                    AS empty_description,
  (SELECT count(*) FROM public.tickets
     WHERE char_length(description) > 5000)                                  AS description_too_long,
  (SELECT count(*) FROM public.ticket_comments
     WHERE body IS NULL OR trim(body) = '')                                  AS empty_comment,
  (SELECT count(*) FROM public.tickets
     WHERE (location_lat IS NOT NULL AND location_lat NOT BETWEEN -90 AND 90)
        OR (location_lng IS NOT NULL AND location_lng NOT BETWEEN -180 AND 180)) AS bad_coordinates;


-- 3. Accounts and roles -------------------------------------------------
SELECT
  u.email,
  p.role,
  p.approval_status,
  (u.email_confirmed_at IS NOT NULL) AS email_verified,
  p.created_at
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
ORDER BY p.created_at DESC NULLS FIRST
LIMIT 25;
-- A row with a NULL role has no profile: the signup trigger from 0002 was
-- missing when that account was created. Delete the user and re-register.


-- 4. Notification queue health -----------------------------------------
SELECT status, count(*) AS count, max(attempts) AS max_attempts
FROM public.notifications
GROUP BY status
ORDER BY status;
-- Anything sitting in 'dead_letter' means the worker gave up. Usually the
-- sending domain is not verified in Resend.
