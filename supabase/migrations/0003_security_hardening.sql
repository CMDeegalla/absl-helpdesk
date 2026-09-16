-- =====================================================================
-- 0003_security_hardening.sql
--
-- Closes the privilege-escalation holes found in the pre-launch audit and
-- adds the write policies that were missing, so that blocked writes fail
-- loudly instead of silently doing nothing.
--
-- What this fixes:
--   1. Any visitor could sign up with role = 'admin' (client-supplied
--      metadata was trusted by handle_new_user).
--   2. Any logged-in user could PATCH their own profile row and set
--      role = 'admin', approval_status = 'approved'.
--   3. An unapproved account with a staff role could read every ticket
--      in the database: role checks never looked at approval_status.
--   4. Customers could change ticket status / assignment directly.
--   5. DELETE and UPDATE were blocked with no policy, so the UI reported
--      success while nothing happened.
--   6. Storage buckets had no policies at all.
--
-- Run this immediately after 0002. Idempotent: safe to re-run.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Role helpers now require an APPROVED profile.
--    Every policy written in 0001/0002 calls current_role(), so this one
--    change closes the "pending staff account can read everything" hole
--    everywhere at once.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_role()
RETURNS public.user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM public.profiles
  WHERE id = auth.uid()
    AND approval_status = 'approved'
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND approval_status = 'approved'
  )
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.current_role() IN ('agent', 'technician', 'admin')
$$;


-- ---------------------------------------------------------------------
-- 2. Signup can no longer choose its own role.
--    The client may REQUEST customer or technician; the profile is always
--    created as an unprivileged customer and a staff request always goes
--    to the admin queue, even on an auto-approve company domain.
-- ---------------------------------------------------------------------
ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS requested_role public.user_role NOT NULL DEFAULT 'customer';

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
SECURITY DEFINER
SET search_path = public, auth
LANGUAGE plpgsql
AS $$
DECLARE
  v_company_id uuid;
  v_company_name text;
  v_full_name text;
  v_email_domain text;
  v_auto_approve boolean;
  v_approval_status public.approval_status;
  v_current_count integer;
  v_account_limit integer;
  v_requested_role public.user_role;
  v_raw_role text;
BEGIN
  v_email_domain := split_part(NEW.email, '@', 2);
  v_company_name := NEW.raw_user_meta_data->>'company_name';
  v_full_name := coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email);

  -- Whatever the client sent is a REQUEST, never an assignment, and only
  -- these two values are accepted. Anything else (including 'admin' and
  -- 'agent') falls back to customer.
  v_raw_role := coalesce(
    nullif(NEW.raw_user_meta_data->>'requested_role', ''),
    nullif(NEW.raw_user_meta_data->>'role', ''),
    'customer'
  );

  IF v_raw_role = 'technician' THEN
    v_requested_role := 'technician';
  ELSE
    v_requested_role := 'customer';
  END IF;

  SELECT company_id, auto_approve
  INTO v_company_id, v_auto_approve
  FROM public.company_domains
  WHERE domain = v_email_domain;

  IF v_company_id IS NULL THEN
    SELECT id, account_limit
    INTO v_company_id, v_account_limit
    FROM public.companies
    WHERE lower(name) = lower(v_company_name);

    IF v_company_id IS NULL AND v_company_name IS NOT NULL THEN
      INSERT INTO public.companies (name, account_limit)
      VALUES (v_company_name, 10)
      RETURNING id INTO v_company_id;

      v_account_limit := 10;
    END IF;
  ELSE
    SELECT account_limit INTO v_account_limit
    FROM public.companies
    WHERE id = v_company_id;
  END IF;

  IF v_company_id IS NOT NULL AND v_account_limit IS NOT NULL THEN
    SELECT count(*) INTO v_current_count
    FROM public.profiles
    WHERE company_id = v_company_id AND approval_status = 'approved';

    IF v_current_count >= v_account_limit THEN
      RAISE EXCEPTION 'Company account limit reached. Please contact your administrator.';
    END IF;
  END IF;

  -- A staff role is NEVER auto-approved, even on a verified domain.
  IF v_auto_approve IS TRUE AND v_requested_role = 'customer' THEN
    v_approval_status := 'approved';
  ELSE
    v_approval_status := 'pending';
  END IF;

  INSERT INTO public.profiles (id, company_id, full_name, email, role, approval_status)
  VALUES (
    NEW.id,
    v_company_id,
    v_full_name,
    NEW.email,
    'customer'::public.user_role,   -- always unprivileged at creation
    v_approval_status
  );

  IF v_approval_status = 'pending' THEN
    INSERT INTO public.approval_requests (
      profile_id, company_name, requested_email, requested_role, status
    )
    VALUES (NEW.id, v_company_name, NEW.email, v_requested_role, 'pending');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ---------------------------------------------------------------------
-- 3. Nobody can promote themselves.
--    Postgres has no column-level RLS, so the "users update own profile"
--    policy has to be backed by a trigger that rejects changes to the
--    privileged columns.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profile_privileges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- service_role / trigger context (no end-user JWT): allow.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- An approved admin acting through admin_review_registration() or the
  -- admin console may change these.
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.approval_status IS DISTINCT FROM OLD.approval_status
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.id IS DISTINCT FROM OLD.id
  THEN
    RAISE EXCEPTION 'You may not change your own role, approval status, or company.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_profile_privileges ON public.profiles;
CREATE TRIGGER guard_profile_privileges
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privileges();


-- ---------------------------------------------------------------------
-- 4. Admin review of a registration, including granting a staff role.
--    This is the ONLY path that can hand out a non-customer role.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_review_registration(
  p_profile_id uuid,
  p_approve boolean,
  p_grant_role public.user_role DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile public.profiles;
  v_requested public.user_role;
  v_role public.user_role;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an approved admin can review registrations.';
  END IF;

  SELECT requested_role INTO v_requested
  FROM public.approval_requests
  WHERE profile_id = p_profile_id
  ORDER BY created_at DESC
  LIMIT 1;

  v_role := coalesce(p_grant_role, v_requested, 'customer');

  IF p_approve THEN
    UPDATE public.profiles
    SET approval_status = 'approved',
        role = v_role,
        rejection_reason = NULL
    WHERE id = p_profile_id
    RETURNING * INTO v_profile;
  ELSE
    UPDATE public.profiles
    SET approval_status = 'rejected',
        rejection_reason = p_reason
    WHERE id = p_profile_id
    RETURNING * INTO v_profile;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  UPDATE public.approval_requests
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END::public.approval_status,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      rejection_reason = p_reason
  WHERE profile_id = p_profile_id
    AND status = 'pending';

  INSERT INTO public.audit_logs (actor_id, action, record_table, record_id, metadata)
  VALUES (
    auth.uid(),
    CASE WHEN p_approve THEN 'registration.approved' ELSE 'registration.rejected' END,
    'profiles',
    p_profile_id,
    jsonb_build_object('granted_role', v_role, 'reason', p_reason)
  );

  RETURN v_profile;
END;
$$;


-- ---------------------------------------------------------------------
-- 5. Customers may edit their own ticket text, but not its status,
--    assignment or version. change_ticket_status() remains the only way
--    to move a ticket, and it sets a flag this guard honours.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_ticket_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Set by change_ticket_status(): the optimistic-locking path.
  IF coalesce(current_setting('absl.status_rpc', true), '') = '1' THEN
    RETURN NEW;
  END IF;

  IF public.is_staff() THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
     OR NEW.assigned_technician_id IS DISTINCT FROM OLD.assigned_technician_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.ticket_number IS DISTINCT FROM OLD.ticket_number
  THEN
    RAISE EXCEPTION 'Only ABSL staff can change ticket status or assignment.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_ticket_fields ON public.tickets;
CREATE TRIGGER guard_ticket_fields
  BEFORE UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.guard_ticket_fields();


-- change_ticket_status(): same optimistic locking as 0001, plus
--   * the guard flag, so the trigger above lets it through
--   * customers may only close their own ticket, never resolve it
CREATE OR REPLACE FUNCTION public.change_ticket_status(
  p_ticket_id uuid,
  p_new_status public.ticket_status,
  p_expected_version integer
)
RETURNS public.tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  locked_ticket public.tickets;
BEGIN
  SELECT * INTO locked_ticket
  FROM public.tickets
  WHERE id = p_ticket_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF NOT public.can_view_ticket(locked_ticket) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF NOT public.is_staff() THEN
    IF locked_ticket.created_by <> auth.uid() OR p_new_status <> 'closed' THEN
      RAISE EXCEPTION 'Only ABSL staff can change this ticket''s status.';
    END IF;
  END IF;

  IF locked_ticket.version <> p_expected_version THEN
    RAISE EXCEPTION 'Conflict: ticket was already updated by another user';
  END IF;

  PERFORM set_config('absl.status_rpc', '1', true);

  UPDATE public.tickets
  SET status = p_new_status,
      version = version + 1
  WHERE id = p_ticket_id
  RETURNING * INTO locked_ticket;

  PERFORM set_config('absl.status_rpc', '0', true);

  RETURN locked_ticket;
END;
$$;


-- ---------------------------------------------------------------------
-- 6. The missing write policies.
--    Without these, PostgREST returns "success, 0 rows" and the UI
--    reports a change that never happened.
-- ---------------------------------------------------------------------

-- tickets: the creator may correct their own ticket while it is still new
DROP POLICY IF EXISTS "Creator updates own new ticket" ON public.tickets;
CREATE POLICY "Creator updates own new ticket"
  ON public.tickets
  FOR UPDATE
  TO authenticated
  USING (created_by = auth.uid() AND status = 'new')
  WITH CHECK (created_by = auth.uid());

-- tickets: only an admin may delete. (The agent/customer Delete buttons
-- will now surface a clear "not permitted" message instead of lying.)
DROP POLICY IF EXISTS "Admins delete tickets" ON public.tickets;
CREATE POLICY "Admins delete tickets"
  ON public.tickets
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- ticket_comments: author may delete their own, admin may delete any
DROP POLICY IF EXISTS "Author or admin deletes comment" ON public.ticket_comments;
CREATE POLICY "Author or admin deletes comment"
  ON public.ticket_comments
  FOR DELETE
  TO authenticated
  USING (author_id = auth.uid() OR public.is_admin());

-- notifications: admin retry button needs UPDATE
DROP POLICY IF EXISTS "Admins update notifications" ON public.notifications;
CREATE POLICY "Admins update notifications"
  ON public.notifications
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- approval_requests: 0001 enabled RLS and defined no policy at all, so the
-- admin approvals panel was always empty.
DROP POLICY IF EXISTS "Own approval request visible" ON public.approval_requests;
CREATE POLICY "Own approval request visible"
  ON public.approval_requests
  FOR SELECT
  TO authenticated
  USING (profile_id = auth.uid() OR public.current_role() IN ('agent', 'admin'));

DROP POLICY IF EXISTS "Admins update approval requests" ON public.approval_requests;
CREATE POLICY "Admins update approval requests"
  ON public.approval_requests
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- inventory_items: technicians must be able to see stock; 0001 covers
-- SELECT. Only admins change it directly; consume_inventory() handles use.
DROP POLICY IF EXISTS "Staff read inventory" ON public.inventory_items;
CREATE POLICY "Staff read inventory"
  ON public.inventory_items
  FOR SELECT
  TO authenticated
  USING (public.current_role() IN ('agent', 'technician', 'admin'));


-- ---------------------------------------------------------------------
-- 7. Notification worker: claim rows so two overlapping cron runs can
--    never send the same email twice.
-- ---------------------------------------------------------------------
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

CREATE INDEX IF NOT EXISTS notifications_due_idx
  ON public.notifications (status, next_attempt_at);

CREATE OR REPLACE FUNCTION public.claim_notifications(p_limit integer DEFAULT 20)
RETURNS SETOF public.notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id
    FROM public.notifications
    WHERE status IN ('pending', 'retry')
      AND next_attempt_at <= now()
    ORDER BY next_attempt_at
    LIMIT greatest(1, least(p_limit, 100))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.notifications n
  SET locked_at = now(),
      -- park the row so a concurrent run cannot pick it up; the worker
      -- rewrites next_attempt_at when it succeeds or fails
      next_attempt_at = now() + interval '10 minutes'
  FROM due
  WHERE n.id = due.id
  RETURNING n.*;
END;
$$;

-- Worker-only: the browser must never be able to call this.
REVOKE ALL ON FUNCTION public.claim_notifications(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notifications(integer) TO service_role;


-- ---------------------------------------------------------------------
-- 8. Storage. The buckets held customer photos and voice notes with no
--    policies; make them private and readable only by people who can
--    already see the ticket. File path convention: <ticket_id>/<file>
-- ---------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES
  ('ticket-photos', 'ticket-photos', false),
  ('ticket-voice-notes', 'ticket-voice-notes', false),
  ('inventory-csv-imports', 'inventory-csv-imports', false)
ON CONFLICT (id) DO UPDATE SET public = false;

CREATE OR REPLACE FUNCTION public.can_access_ticket_file(p_path text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_id uuid;
BEGIN
  BEGIN
    v_ticket_id := split_part(p_path, '/', 1)::uuid;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;

  RETURN public.can_view_ticket(v_ticket_id);
END;
$$;

DROP POLICY IF EXISTS "Ticket files readable by ticket viewers" ON storage.objects;
CREATE POLICY "Ticket files readable by ticket viewers"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id IN ('ticket-photos', 'ticket-voice-notes')
    AND public.can_access_ticket_file(name)
  );

DROP POLICY IF EXISTS "Ticket files uploadable by ticket viewers" ON storage.objects;
CREATE POLICY "Ticket files uploadable by ticket viewers"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id IN ('ticket-photos', 'ticket-voice-notes')
    AND owner = auth.uid()
    AND public.can_access_ticket_file(name)
  );

DROP POLICY IF EXISTS "Inventory imports are admin only" ON storage.objects;
CREATE POLICY "Inventory imports are admin only"
  ON storage.objects
  FOR ALL
  TO authenticated
  USING (bucket_id = 'inventory-csv-imports' AND public.is_admin())
  WITH CHECK (bucket_id = 'inventory-csv-imports' AND public.is_admin());
