-- =====================================================================
-- 0005_video_receipts_site_contact.sql
--
--   1. Video clips as a third attachment type, alongside photo and voice.
--   2. A site contact number on the ticket — the person to call on
--      arrival, who is often not the account holder who filed it.
--   3. The customer is now emailed when a technician is assigned, not
--      only the technician.
--   4. A resolution receipt, generated automatically the moment a ticket
--      becomes Resolved, with its own unique number, visible only to
--      admins.
--
-- Idempotent: safe to re-run.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Video attachments.
-- ---------------------------------------------------------------------
ALTER TABLE public.ticket_attachments
  DROP CONSTRAINT IF EXISTS ticket_attachments_file_type_check;
ALTER TABLE public.ticket_attachments
  ADD CONSTRAINT ticket_attachments_file_type_check
  CHECK (file_type IN ('photo', 'voice', 'video'));

INSERT INTO storage.buckets (id, name, public)
VALUES ('ticket-videos', 'ticket-videos', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Extend the storage policies from 0003 to cover the new bucket. The
-- access rule is identical — tied to whoever can see the ticket — so this
-- replaces the two policies rather than adding narrower ones per bucket.
DROP POLICY IF EXISTS "Ticket files readable by ticket viewers" ON storage.objects;
CREATE POLICY "Ticket files readable by ticket viewers"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id IN ('ticket-photos', 'ticket-voice-notes', 'ticket-videos')
    AND public.can_access_ticket_file(name)
  );

DROP POLICY IF EXISTS "Ticket files uploadable by ticket viewers" ON storage.objects;
CREATE POLICY "Ticket files uploadable by ticket viewers"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id IN ('ticket-photos', 'ticket-voice-notes', 'ticket-videos')
    AND owner = auth.uid()
    AND public.can_access_ticket_file(name)
  );


-- ---------------------------------------------------------------------
-- 2. Site contact number — who a technician calls on arrival. Often not
--    the same person as the account holder who raised the ticket.
-- ---------------------------------------------------------------------
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS site_contact_phone text;


-- ---------------------------------------------------------------------
-- 3. reassign_ticket(): now also tells the customer a technician is on
--    the job, not only the technician themselves.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reassign_ticket(
  p_ticket_id uuid,
  p_technician_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS public.tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.tickets;
  v_previous uuid;
  v_new_name text;
  v_new_email text;
  v_old_name text;
  v_customer_email text;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Only ABSL staff can assign a technician.';
  END IF;

  SELECT * INTO v_ticket FROM public.tickets WHERE id = p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  v_previous := v_ticket.assigned_technician_id;

  IF p_technician_id IS NOT NULL THEN
    SELECT full_name, email INTO v_new_name, v_new_email
    FROM public.profiles
    WHERE id = p_technician_id
      AND role = 'technician'
      AND approval_status = 'approved';

    IF v_new_name IS NULL THEN
      RAISE EXCEPTION 'That technician is not an approved technician account.';
    END IF;
  END IF;

  SELECT full_name INTO v_old_name FROM public.profiles WHERE id = v_previous;

  PERFORM set_config('absl.status_rpc', '1', true);
  UPDATE public.tickets
  SET assigned_technician_id = p_technician_id
  WHERE id = p_ticket_id
  RETURNING * INTO v_ticket;
  PERFORM set_config('absl.status_rpc', '0', true);

  -- Visible hand-off note on the thread (Diagram 12).
  INSERT INTO public.ticket_comments (ticket_id, author_id, body)
  VALUES (
    p_ticket_id,
    auth.uid(),
    CASE
      WHEN p_technician_id IS NULL THEN 'Technician unassigned.'
      WHEN v_previous IS NULL THEN 'Technician assigned: ' || v_new_name || '.'
      ELSE 'Job handed over from ' || coalesce(v_old_name, 'a colleague') || ' to ' || v_new_name || '.'
    END ||
    CASE WHEN coalesce(trim(p_reason), '') = '' THEN '' ELSE ' Reason: ' || trim(p_reason) END
  );

  -- Tell the technician they have work.
  IF p_technician_id IS NOT NULL AND v_new_email IS NOT NULL THEN
    INSERT INTO public.notifications (
      ticket_id, recipient_profile_id, recipient_email, channel, subject, body
    )
    VALUES (
      p_ticket_id,
      p_technician_id,
      v_new_email,
      'email',
      'Job assigned: ' || v_ticket.ticket_number,
      'You have been assigned to ticket ' || v_ticket.ticket_number || ': ' || v_ticket.title
    );
  END IF;

  -- Tell the customer too — a new addition. First assignment only, so a
  -- hand-over between two technicians does not double-notify the customer
  -- for what is, to them, the same event already announced.
  IF p_technician_id IS NOT NULL AND v_previous IS NULL THEN
    SELECT email INTO v_customer_email FROM public.profiles WHERE id = v_ticket.created_by;

    IF v_customer_email IS NOT NULL THEN
      INSERT INTO public.notifications (
        ticket_id, recipient_profile_id, recipient_email, channel, subject, body
      )
      VALUES (
        p_ticket_id,
        v_ticket.created_by,
        v_customer_email,
        'email',
        'Technician assigned: ' || v_ticket.ticket_number,
        v_new_name || ' has been assigned to your ticket ' || v_ticket.ticket_number || ' and will be in touch.'
      );
    END IF;
  END IF;

  INSERT INTO public.audit_logs (actor_id, action, record_table, record_id, metadata)
  VALUES (auth.uid(), 'ticket.reassigned', 'tickets', p_ticket_id,
          jsonb_build_object('from', v_previous, 'to', p_technician_id, 'reason', p_reason));

  RETURN v_ticket;
END;
$$;


-- ---------------------------------------------------------------------
-- 4. Resolution receipts.
--    Fires the moment a ticket transitions INTO 'resolved' — including a
--    second time, if it is ever reopened and resolved again, since each
--    resolution is a separate service event with its own parts snapshot.
--    A receipt is a business record and deliberately does not reference
--    the ticket with a cascading foreign key: if the ticket is later
--    deleted, the receipt survives as the record of the work that was done.
-- ---------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.receipt_number_seq;

CREATE TABLE IF NOT EXISTS public.ticket_receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_number text not null unique,
  ticket_id uuid references public.tickets(id) on delete set null,
  ticket_number text not null,
  company_name text,
  customer_name text,
  customer_email text,
  technician_name text,
  agent_name text,
  title text not null,
  priority text,
  parts_used jsonb not null default '[]'::jsonb,
  created_at_original timestamptz,
  resolved_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS ticket_receipts_ticket_idx ON public.ticket_receipts (ticket_id);
CREATE INDEX IF NOT EXISTS ticket_receipts_resolved_idx ON public.ticket_receipts (resolved_at DESC);

ALTER TABLE public.ticket_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins view receipts" ON public.ticket_receipts;
CREATE POLICY "Admins view receipts"
  ON public.ticket_receipts
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.generate_ticket_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receipt_number text;
  v_company_name text;
  v_customer_name text;
  v_customer_email text;
  v_technician_name text;
  v_agent_name text;
  v_parts jsonb;
BEGIN
  v_receipt_number :=
    'RCT-' || to_char(now(), 'YYYY') || '-' ||
    lpad(nextval('public.receipt_number_seq')::text, 6, '0');

  SELECT name INTO v_company_name FROM public.companies WHERE id = NEW.company_id;
  SELECT full_name, email INTO v_customer_name, v_customer_email
    FROM public.profiles WHERE id = NEW.created_by;
  SELECT full_name INTO v_technician_name
    FROM public.profiles WHERE id = NEW.assigned_technician_id;
  -- Whoever's session is running this UPDATE — auth.uid() reads the JWT of
  -- the caller regardless of SECURITY DEFINER, so this is the agent/admin
  -- who actually moved the ticket to Resolved via change_ticket_status().
  -- assigned_agent_id is never populated anywhere in the app, so it is not
  -- a usable fallback.
  SELECT full_name INTO v_agent_name
    FROM public.profiles WHERE id = auth.uid();

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'name', i.name, 'sku', i.sku, 'quantity', abs(m.quantity)
         ) ORDER BY m.created_at), '[]'::jsonb)
  INTO v_parts
  FROM public.inventory_movements m
  JOIN public.inventory_items i ON i.id = m.inventory_item_id
  WHERE m.ticket_id = NEW.id;

  INSERT INTO public.ticket_receipts (
    receipt_number, ticket_id, ticket_number, company_name,
    customer_name, customer_email, technician_name, agent_name,
    title, priority, parts_used, created_at_original, resolved_at
  )
  VALUES (
    v_receipt_number, NEW.id, NEW.ticket_number, v_company_name,
    v_customer_name, v_customer_email, v_technician_name, v_agent_name,
    NEW.title, NEW.priority, v_parts, NEW.created_at, now()
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_ticket_resolved ON public.tickets;
CREATE TRIGGER on_ticket_resolved
  AFTER UPDATE OF status ON public.tickets
  FOR EACH ROW
  WHEN (NEW.status = 'resolved' AND OLD.status IS DISTINCT FROM 'resolved')
  EXECUTE FUNCTION public.generate_ticket_receipt();
