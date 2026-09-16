-- =====================================================================
-- 0002_production_ready.sql
--
-- FIXED 2026-08-22. The previous version of this file could not be
-- applied: it referenced columns that do not exist in 0001, so the whole
-- script aborted at the first callback_requests policy and nothing in it
-- ever reached the database.
--
-- Corrections made:
--   * callback_requests.customer_id      -> requested_by   (real column)
--   * can_view_ticket(ticket_id uuid)    -> overload added below
--   * notifications(user_id, notification_type)
--                                        -> recipient_profile_id,
--                                           recipient_email, channel
--
-- Idempotent: safe to run on a fresh project or on one where an earlier
-- attempt was rolled back.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. can_view_ticket() overload taking a ticket id
--    0001 only defines can_view_ticket(public.tickets). Policies on
--    child tables only have the foreign key, so they need this form.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_view_ticket(p_ticket_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tickets t
    WHERE t.id = p_ticket_id
      AND public.can_view_ticket(t)
  )
$$;


-- ---------------------------------------------------------------------
-- 1. handle_new_user() — creates the profile row on signup.
--    NOTE: this version still trusts the client-supplied role. It is
--    replaced by the hardened version in 0003_security_hardening.sql.
--    Run 0003 immediately after this file.
-- ---------------------------------------------------------------------
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
BEGIN
  v_email_domain := split_part(NEW.email, '@', 2);
  v_company_name := NEW.raw_user_meta_data->>'company_name';
  v_full_name := NEW.raw_user_meta_data->>'full_name';

  IF v_full_name IS NULL THEN
    v_full_name := NEW.email;
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

  IF v_company_id IS NOT NULL THEN
    SELECT count(*) INTO v_current_count
    FROM public.profiles
    WHERE company_id = v_company_id AND approval_status = 'approved';

    IF v_current_count >= v_account_limit THEN
      RAISE EXCEPTION 'Company account limit reached. Please contact your administrator.';
    END IF;
  END IF;

  IF v_auto_approve IS TRUE THEN
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
    coalesce((NEW.raw_user_meta_data->>'role')::public.user_role, 'customer'::public.user_role),
    v_approval_status
  );

  IF v_approval_status = 'pending' THEN
    INSERT INTO public.approval_requests (profile_id, company_name, requested_email, status)
    VALUES (NEW.id, v_company_name, NEW.email, 'pending');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ---------------------------------------------------------------------
-- 2. admin_alerts table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_alerts (
  id uuid primary key default gen_random_uuid(),
  alert_type text not null default 'general',
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  title text not null,
  body text not null default '',
  related_record_id uuid,
  acknowledged boolean not null default false,
  acknowledged_by uuid references public.profiles(id),
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);

-- Set once the nightly digest has told the admins about this alert.
-- The alert still shows in the console until a human acknowledges it.
ALTER TABLE public.admin_alerts
  ADD COLUMN IF NOT EXISTS digest_sent_at timestamptz;

ALTER TABLE public.admin_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view admin_alerts" ON public.admin_alerts;
CREATE POLICY "Admins can view admin_alerts"
  ON public.admin_alerts
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
        AND profiles.approval_status = 'approved'
    )
  );

DROP POLICY IF EXISTS "Admins can update admin_alerts" ON public.admin_alerts;
CREATE POLICY "Admins can update admin_alerts"
  ON public.admin_alerts
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
        AND profiles.approval_status = 'approved'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
        AND profiles.approval_status = 'approved'
    )
  );


-- ---------------------------------------------------------------------
-- 3. queue_dead_letter_alert()
--    Fires when a notification gives up permanently (Diagram 19).
--    Raises an admin_alerts row AND queues an email to every admin.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.queue_dead_letter_alert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin record;
BEGIN
  INSERT INTO public.admin_alerts (alert_type, severity, title, body, related_record_id)
  VALUES (
    'dead_letter',
    'critical',
    'Notification permanently failed',
    'Subject: ' || coalesce(NEW.subject, '') || '. Error: ' || coalesce(NEW.error_message, ''),
    NEW.id
  );

  FOR v_admin IN
    SELECT id, email
    FROM public.profiles
    WHERE role = 'admin'
      AND approval_status = 'approved'
      AND email IS NOT NULL
  LOOP
    INSERT INTO public.notifications (
      recipient_profile_id,
      recipient_email,
      channel,
      subject,
      body
    )
    VALUES (
      v_admin.id,
      v_admin.email,
      'email',
      'ALERT: Notification permanently failed',
      'A notification has permanently failed. Subject: ' || coalesce(NEW.subject, '') ||
      '. Error: ' || coalesce(NEW.error_message, '')
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_notification_dead_letter ON public.notifications;
CREATE TRIGGER on_notification_dead_letter
  AFTER UPDATE ON public.notifications
  FOR EACH ROW
  WHEN (NEW.status = 'dead_letter' AND OLD.status IS DISTINCT FROM 'dead_letter')
  EXECUTE FUNCTION public.queue_dead_letter_alert();


-- ---------------------------------------------------------------------
-- 4. Policies for the tables 0001 locked down but never opened up
-- ---------------------------------------------------------------------

-- callback_requests (column is requested_by, not customer_id)
DROP POLICY IF EXISTS "Customers can view their own callback requests" ON public.callback_requests;
CREATE POLICY "Customers can view their own callback requests"
  ON public.callback_requests
  FOR SELECT
  TO authenticated
  USING (requested_by = auth.uid());

DROP POLICY IF EXISTS "Staff can view all callback requests" ON public.callback_requests;
CREATE POLICY "Staff can view all callback requests"
  ON public.callback_requests
  FOR SELECT
  TO authenticated
  USING (public.current_role() IN ('agent', 'admin'));

DROP POLICY IF EXISTS "Customers can insert their own callback requests" ON public.callback_requests;
CREATE POLICY "Customers can insert their own callback requests"
  ON public.callback_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    requested_by = auth.uid()
    AND public.can_view_ticket(ticket_id)
  );

DROP POLICY IF EXISTS "Staff can update callback requests" ON public.callback_requests;
CREATE POLICY "Staff can update callback requests"
  ON public.callback_requests
  FOR UPDATE
  TO authenticated
  USING (public.current_role() IN ('agent', 'admin'))
  WITH CHECK (public.current_role() IN ('agent', 'admin'));


-- ticket_status_history
DROP POLICY IF EXISTS "Visible to anyone who can view the related ticket" ON public.ticket_status_history;
CREATE POLICY "Visible to anyone who can view the related ticket"
  ON public.ticket_status_history
  FOR SELECT
  TO authenticated
  USING (public.can_view_ticket(ticket_id));


-- inventory_movements
DROP POLICY IF EXISTS "Visible to staff" ON public.inventory_movements;
CREATE POLICY "Visible to staff"
  ON public.inventory_movements
  FOR SELECT
  TO authenticated
  USING (public.current_role() IN ('agent', 'technician', 'admin'));

DROP POLICY IF EXISTS "Insert by technician and admin only" ON public.inventory_movements;
CREATE POLICY "Insert by technician and admin only"
  ON public.inventory_movements
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.current_role() IN ('technician', 'admin')
    AND technician_id = auth.uid()
  );


-- audit_logs
DROP POLICY IF EXISTS "Visible to admin only" ON public.audit_logs;
CREATE POLICY "Visible to admin only"
  ON public.audit_logs
  FOR SELECT
  TO authenticated
  USING (public.current_role() = 'admin');

DROP POLICY IF EXISTS "Insert by authenticated users" ON public.audit_logs;
CREATE POLICY "Insert by authenticated users"
  ON public.audit_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (actor_id = auth.uid());
