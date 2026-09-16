-- =====================================================================
-- bootstrap_staff.sql
--
-- Promotes existing accounts to staff roles. Run this in the Supabase SQL
-- editor AFTER the person has registered through the app in the normal way.
--
-- No passwords appear here: everyone sets their own at signup, and the
-- account already exists in auth.users by the time you run this.
--
-- The first admin has to be made this way, because 0003 stops the
-- application itself from ever handing out a privileged role.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Who has registered so far? Run this first to check the email.
-- ---------------------------------------------------------------------
-- SELECT u.email, p.role, p.approval_status, u.email_confirmed_at
-- FROM auth.users u
-- LEFT JOIN public.profiles p ON p.id = u.id
-- ORDER BY u.created_at DESC
-- LIMIT 50;


-- ---------------------------------------------------------------------
-- 2. Promote one person. Edit the two values, then run.
--    Roles: 'customer' | 'agent' | 'technician' | 'admin'
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_email text := 'ceo@automatedbarcode.net';   -- <-- change me
  v_role  public.user_role := 'admin';          -- <-- change me
  v_id    uuid;
BEGIN
  SELECT id INTO v_id FROM auth.users WHERE lower(email) = lower(v_email);

  IF v_id IS NULL THEN
    RAISE EXCEPTION
      'No account for %. Ask them to register in the app first, then run this again.',
      v_email;
  END IF;

  UPDATE public.profiles
  SET role = v_role,
      approval_status = 'approved',
      rejection_reason = NULL
  WHERE id = v_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Account % exists but has no profile row. Check that the on_auth_user_created trigger from 0002 is installed.',
      v_email;
  END IF;

  UPDATE public.approval_requests
  SET status = 'approved',
      reviewed_at = now()
  WHERE profile_id = v_id
    AND status = 'pending';

  RAISE NOTICE 'Granted % to %', v_role, v_email;
END $$;


-- ---------------------------------------------------------------------
-- 3. Confirm
-- ---------------------------------------------------------------------
SELECT u.email, p.full_name, p.role, p.approval_status
FROM public.profiles p
JOIN auth.users u ON u.id = p.id
WHERE p.role <> 'customer'
ORDER BY p.role, u.email;
