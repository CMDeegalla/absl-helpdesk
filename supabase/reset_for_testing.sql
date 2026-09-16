-- =====================================================================
-- reset_for_testing.sql
--
--   !!  DESTRUCTIVE AND IRREVERSIBLE  !!
--
-- Deletes EVERY account, ticket, comment, attachment record, resolution
-- receipt, notification and audit record in this project. It keeps the
-- schema, the companies, the verified domains and the inventory catalogue,
-- and resets stock, ticket numbering and receipt numbering to a clean
-- state — this is the "go live with a brand-new database" reset as much as
-- it is a test-data reset; the two are the same operation.
--
-- Uploaded FILES are not removed: Supabase blocks deleting them from SQL.
-- Empty the buckets from the dashboard — see the note at the end.
--
-- Intended for a pre-launch project holding nothing but test data.
-- Do not run this once real customers exist.
--
-- TO ARM IT: change the line
--     v_i_am_sure boolean := false;
-- to
--     v_i_am_sure boolean := true;
-- and run the whole file. It refuses to do anything until you do.
-- =====================================================================

DO $$
DECLARE
  v_i_am_sure boolean := false;   -- <== change to true to run

  v_users    integer;
  v_tickets  integer;
  v_files    integer;
BEGIN
  SELECT count(*) INTO v_users   FROM auth.users;
  SELECT count(*) INTO v_tickets FROM public.tickets;
  SELECT count(*) INTO v_files   FROM storage.objects
    WHERE bucket_id IN ('ticket-photos', 'ticket-voice-notes', 'ticket-videos', 'ticket-service-receipts', 'inventory-csv-imports');

  IF NOT v_i_am_sure THEN
    RAISE EXCEPTION
      'Not armed. This would delete % accounts, % tickets and % stored files. Set v_i_am_sure := true to proceed.',
      v_users, v_tickets, v_files;
  END IF;

  RAISE NOTICE 'Deleting % accounts, % tickets, % stored files…', v_users, v_tickets, v_files;

  -- Order matters: the tables that point at tickets and profiles without
  -- a cascade have to go first, or the deletes below fail on a foreign key.
  DELETE FROM public.inventory_movements;
  DELETE FROM public.audit_logs;
  DELETE FROM public.admin_alerts;
  DELETE FROM public.notification_attempts;
  DELETE FROM public.notifications;
  DELETE FROM public.callback_requests;
  DELETE FROM public.ticket_status_history;
  DELETE FROM public.ticket_comments;
  DELETE FROM public.ticket_attachments;
  -- ticket_receipts.ticket_id is ON DELETE SET NULL (a receipt is meant to
  -- outlive the ticket it came from), so deleting tickets first would leave
  -- every old receipt behind, orphaned but intact. Explicit for a full reset.
  DELETE FROM public.ticket_receipts;
  -- Same reasoning: client_error_logs.profile_id is ON DELETE SET NULL, so
  -- old error reports would otherwise survive with no owner.
  DELETE FROM public.client_error_logs;
  DELETE FROM public.tickets;
  DELETE FROM public.approval_requests;
  DELETE FROM public.profiles;

  -- Removing the auth user cascades to anything keyed on it.
  DELETE FROM auth.users;

  -- Start ticket and receipt numbering from 1 again.
  ALTER SEQUENCE public.ticket_number_seq RESTART WITH 1;
  ALTER SEQUENCE public.receipt_number_seq RESTART WITH 1;

  -- Storage is deliberately NOT touched here. Supabase protects
  -- storage.objects with a trigger (storage.protect_delete) that rejects a
  -- direct DELETE, and because this whole block is one transaction, trying it
  -- rolls back the entire reset. Empty the buckets from the dashboard, or
  -- leave them: with every ticket_attachments row gone, the files are
  -- unreferenced and unreachable — the app can no longer produce a signed
  -- URL for any of them.
  IF v_files > 0 THEN
    RAISE NOTICE 'Database cleared. % file(s) still sit in storage — see the note at the end of this script.', v_files;
  ELSE
    RAISE NOTICE 'Done. Storage was already empty.';
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- Reset the catalogue to known quantities, so stock tests are repeatable.
-- ---------------------------------------------------------------------
INSERT INTO public.inventory_items (sku, name, category, quantity_on_hand, reorder_level, unit_cost)
VALUES
  ('RBN-110-74', 'Wax ribbon 110mm x 74m',  'Ribbon',        24, 5,  1800.00),
  ('LBL-50-25',  'Label roll 50mm x 25mm',  'Labels',         8, 5,   950.00),
  ('HDR-ZD220',  'Print head ZD220',        'Printer Parts',  4, 2, 18500.00)
ON CONFLICT (sku) DO UPDATE
SET quantity_on_hand = excluded.quantity_on_hand,
    reorder_level    = excluded.reorder_level,
    unit_cost        = excluded.unit_cost;


-- ---------------------------------------------------------------------
-- Make sure the company and its verified domain exist.
-- ---------------------------------------------------------------------
INSERT INTO public.companies (name, account_limit, status)
VALUES ('Automated Barcode Solutions Pvt Ltd', 25, 'active')
ON CONFLICT (name) DO UPDATE SET account_limit = 25, status = 'active';

INSERT INTO public.company_domains (company_id, domain, auto_approve)
SELECT id, 'automatedbarcode.net', true
FROM public.companies
WHERE name = 'Automated Barcode Solutions Pvt Ltd'
ON CONFLICT (domain) DO UPDATE
SET company_id   = excluded.company_id,
    auto_approve = excluded.auto_approve;


-- ---------------------------------------------------------------------
-- Confirm the reset. Every count should be 0, inventory should show 3 rows.
-- ---------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM auth.users)             AS accounts,
  (SELECT count(*) FROM public.profiles)        AS profiles,
  (SELECT count(*) FROM public.tickets)         AS tickets,
  (SELECT count(*) FROM public.ticket_receipts) AS receipts,
  (SELECT count(*) FROM public.client_error_logs) AS client_errors,
  (SELECT count(*) FROM public.notifications)   AS notifications,
  (SELECT count(*) FROM public.admin_alerts)    AS alerts,
  (SELECT count(*) FROM public.inventory_items) AS inventory_items,
  (SELECT count(*) FROM public.companies)       AS companies;


-- ---------------------------------------------------------------------
-- Emptying the storage buckets — do this by hand, it cannot be done here.
--
-- Supabase blocks DELETE on storage.objects from SQL. Attempting it aborts
-- the whole transaction, which is why this script no longer tries.
--
-- Dashboard  →  Storage  →  open each bucket  →  select all  →  Delete:
--      ticket-photos
--      ticket-voice-notes
--      ticket-videos
--      ticket-service-receipts
--      inventory-csv-imports
--
-- Or from the CLI:
--      supabase storage rm --experimental -r ss:///ticket-photos
--      supabase storage rm --experimental -r ss:///ticket-voice-notes
--      supabase storage rm --experimental -r ss:///ticket-videos
--      supabase storage rm --experimental -r ss:///ticket-service-receipts
--
-- Skipping it is safe for testing. Every ticket_attachments row is gone, so
-- nothing references those files and the app cannot sign a URL for them.
-- They only take up quota.
--
-- What is still in there:
SELECT
  bucket_id,
  count(*)                       AS files,
  pg_size_pretty(sum((metadata->>'size')::bigint)) AS total_size
FROM storage.objects
WHERE bucket_id IN ('ticket-photos', 'ticket-voice-notes', 'ticket-videos', 'ticket-service-receipts', 'inventory-csv-imports')
GROUP BY bucket_id
ORDER BY bucket_id;
