-- =====================================================================
-- promote_test_accounts.sql
--
-- Grants roles to the test cast, after each person has registered through
-- the app in the normal way and verified their email.
--
-- No passwords appear here and none are set — everyone chose their own at
-- signup. Safe to keep in the repository, safe to re-run.
--
-- The customer needs no entry: every account starts as a customer.
-- =====================================================================

DO $$
DECLARE
  -- ---- the cast ------------------------------------------------------
  -- Add or remove rows freely. Roles: admin | agent | technician | customer
  v_cast text[][] := ARRAY[
    ARRAY['info@chenitha.net',            'admin'],
    ARRAY['dilumperera33@gmail.com',      'technician']
    -- ARRAY['chenitharanasinghe+tech2@gmail.com', 'technician'],
    -- ARRAY['chenitharanasinghe+agent@gmail.com', 'agent']
  ];
  -- --------------------------------------------------------------------
BEGIN
  FOR i IN 1 .. array_length(v_cast, 1) LOOP
    DECLARE
      v_email text := v_cast[i][1];
      v_role  text := v_cast[i][2];
      v_id    uuid;
    BEGIN
      SELECT id INTO v_id FROM auth.users WHERE lower(email) = lower(v_email);

      IF v_id IS NULL THEN
        RAISE WARNING 'SKIPPED %  — no account yet. Register in the app first.', v_email;
        CONTINUE;
      END IF;

      UPDATE public.profiles
      SET role             = v_role::public.user_role,
          approval_status  = 'approved',
          rejection_reason = NULL
      WHERE id = v_id;

      IF NOT FOUND THEN
        RAISE WARNING 'SKIPPED %  — account exists but has no profile row. Check the 0002 signup trigger.', v_email;
        CONTINUE;
      END IF;

      UPDATE public.approval_requests
      SET status = 'approved', reviewed_at = now()
      WHERE profile_id = v_id AND status = 'pending';

      RAISE NOTICE 'OK  %  ->  %', v_email, v_role;
    END;
  END LOOP;
END $$;


-- Confirm the cast: expected role, approved, and email verified.
SELECT
  u.email,
  p.full_name,
  p.role,
  p.approval_status,
  c.name AS company,
  (u.email_confirmed_at IS NOT NULL) AS email_verified
FROM auth.users u
LEFT JOIN public.profiles  p ON p.id = u.id
LEFT JOIN public.companies c ON c.id = p.company_id
ORDER BY
  CASE p.role
    WHEN 'admin' THEN 1
    WHEN 'agent' THEN 2
    WHEN 'technician' THEN 3
    ELSE 4
  END,
  u.email;
