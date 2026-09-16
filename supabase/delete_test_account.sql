-- =====================================================================
-- delete_test_account.sql
--
--   !!  DESTRUCTIVE AND IRREVERSIBLE  !!
--
-- Deletes ONE account (by email) so you can register that same email
-- again fresh - for testing the registration/approval flow repeatedly
-- without reset_for_testing.sql wiping every account in the project.
--
-- Deleting straight from auth.users would fail with a foreign key error
-- if this account has ever created a ticket, received a notification, or
-- had an approval request - those rows point at the profile and are not
-- all set to cascade automatically. This clears them first, in the
-- correct order, then removes the account itself.
--
-- Uploaded FILES this account attached are not removed - Supabase blocks
-- deleting storage objects from SQL. If this test account uploaded
-- anything, empty the relevant bucket by hand afterward (Dashboard ->
-- Storage), same as reset_for_testing.sql explains.
--
-- TO ARM IT: change the line
--     v_i_am_sure boolean := false;
-- to
--     v_i_am_sure boolean := true;
-- and set v_email below to the account you want gone, then run the file.
-- =====================================================================

DO $$
DECLARE
  v_i_am_sure boolean := false;             -- <== change to true to run
  v_email     text    := 'test@example.com'; -- <== change to the account's email

  v_profile_id uuid;
  v_tickets    integer;
BEGIN
  SELECT id INTO v_profile_id FROM auth.users WHERE lower(email) = lower(v_email);

  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'No account found for %.', v_email;
  END IF;

  SELECT count(*) INTO v_tickets FROM public.tickets WHERE created_by = v_profile_id;

  IF NOT v_i_am_sure THEN
    RAISE EXCEPTION
      'Not armed. This would permanently delete the account % (and % ticket(s) it created, if any). Set v_i_am_sure := true to proceed.',
      v_email, v_tickets;
  END IF;

  RAISE NOTICE 'Deleting account % (% ticket(s) created)…', v_email, v_tickets;

  -- Same ordering reset_for_testing.sql uses, just scoped to this one
  -- profile/its tickets instead of every row in the project.
  DELETE FROM public.inventory_movements WHERE ticket_id IN (SELECT id FROM public.tickets WHERE created_by = v_profile_id);
  DELETE FROM public.audit_logs WHERE actor_id = v_profile_id;
  DELETE FROM public.notification_attempts WHERE notification_id IN (SELECT id FROM public.notifications WHERE recipient_profile_id = v_profile_id);
  DELETE FROM public.notifications WHERE recipient_profile_id = v_profile_id
     OR ticket_id IN (SELECT id FROM public.tickets WHERE created_by = v_profile_id);
  DELETE FROM public.callback_requests WHERE ticket_id IN (SELECT id FROM public.tickets WHERE created_by = v_profile_id);
  DELETE FROM public.ticket_status_history WHERE ticket_id IN (SELECT id FROM public.tickets WHERE created_by = v_profile_id);
  DELETE FROM public.ticket_comments WHERE ticket_id IN (SELECT id FROM public.tickets WHERE created_by = v_profile_id) OR author_id = v_profile_id;
  DELETE FROM public.ticket_attachments WHERE ticket_id IN (SELECT id FROM public.tickets WHERE created_by = v_profile_id) OR uploaded_by = v_profile_id;
  DELETE FROM public.ticket_receipts WHERE ticket_id IN (SELECT id FROM public.tickets WHERE created_by = v_profile_id);
  DELETE FROM public.tickets WHERE created_by = v_profile_id;
  DELETE FROM public.approval_requests WHERE profile_id = v_profile_id;

  -- Removing the auth user cascades to the profiles row itself.
  DELETE FROM auth.users WHERE id = v_profile_id;

  RAISE NOTICE 'Done. % is gone and free to register again.', v_email;
END $$;


-- Confirm: this should return no rows.
SELECT u.id, u.email, p.role, p.approval_status
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE lower(u.email) = lower('test@example.com'); -- match v_email above
