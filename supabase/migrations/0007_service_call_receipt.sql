-- =====================================================================
-- 0007_service_call_receipt.sql
--
-- A technician resolving a ticket must now provide:
--   1. A service call number (the reference on their physical/paper
--      service call docket).
--   2. A photo of that service call receipt, attached as evidence.
--
-- Enforced here, not just in the UI - change_ticket_status() now refuses
-- to move a ticket to 'resolved' for a technician unless both are present,
-- the same way every other rule in this app has been enforced server-side
-- since the security hardening pass. Agents and admins are unaffected:
-- they already have full override authority over ticket status and are
-- not the ones physically holding the paper receipt.
--
-- Idempotent: safe to re-run.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Where the service call number lives, and a new attachment type for
--    the receipt photo - same pattern as video in 0005.
-- ---------------------------------------------------------------------
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS service_call_number text;

ALTER TABLE public.ticket_attachments
  DROP CONSTRAINT IF EXISTS ticket_attachments_file_type_check;
ALTER TABLE public.ticket_attachments
  ADD CONSTRAINT ticket_attachments_file_type_check
  CHECK (file_type IN ('photo', 'voice', 'video', 'service_receipt'));

INSERT INTO storage.buckets (id, name, public)
VALUES ('ticket-service-receipts', 'ticket-service-receipts', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Same access rule as every other ticket-file bucket: tied to whoever can
-- see the ticket, not to which bucket the file happens to sit in.
DROP POLICY IF EXISTS "Ticket files readable by ticket viewers" ON storage.objects;
CREATE POLICY "Ticket files readable by ticket viewers"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id IN ('ticket-photos', 'ticket-voice-notes', 'ticket-videos', 'ticket-service-receipts')
    AND public.can_access_ticket_file(name)
  );

DROP POLICY IF EXISTS "Ticket files uploadable by ticket viewers" ON storage.objects;
CREATE POLICY "Ticket files uploadable by ticket viewers"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id IN ('ticket-photos', 'ticket-voice-notes', 'ticket-videos', 'ticket-service-receipts')
    AND owner = auth.uid()
    AND public.can_access_ticket_file(name)
  );


-- ---------------------------------------------------------------------
-- 2. change_ticket_status(): require both, for a technician, resolving.
--    p_service_call_number is a new 4th parameter with a default, so
--    every existing caller (customer closing their own ticket, agent/admin
--    changing any status) keeps working unchanged.
--
--    Postgres identifies a function by name AND argument list, so adding a
--    parameter does not replace the old 3-argument version - it silently
--    creates a second overload sitting alongside it. Drop the old
--    signature explicitly, or the app (which now always calls the
--    4-argument form) leaves it as permanent, confusing dead weight.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.change_ticket_status(uuid, public.ticket_status, integer);

CREATE OR REPLACE FUNCTION public.change_ticket_status(
  p_ticket_id uuid,
  p_new_status public.ticket_status,
  p_expected_version integer,
  p_service_call_number text DEFAULT NULL
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

  -- A technician resolving a job must show their work: a service call
  -- number and a photo of the receipt, checked against what is actually in
  -- the database, not just whatever the client claims it uploaded.
  IF p_new_status = 'resolved' AND public.current_role() = 'technician' THEN
    IF coalesce(trim(p_service_call_number), '') = '' THEN
      RAISE EXCEPTION 'A service call number is required to resolve this ticket.';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.ticket_attachments
      WHERE ticket_id = p_ticket_id AND file_type = 'service_receipt'
    ) THEN
      RAISE EXCEPTION 'A photo of the service call receipt is required to resolve this ticket.';
    END IF;
  END IF;

  PERFORM set_config('absl.status_rpc', '1', true);

  UPDATE public.tickets
  SET status = p_new_status,
      version = version + 1,
      service_call_number = CASE
        WHEN p_new_status = 'resolved' AND p_service_call_number IS NOT NULL
          THEN trim(p_service_call_number)
        ELSE service_call_number
      END
  WHERE id = p_ticket_id
  RETURNING * INTO locked_ticket;

  PERFORM set_config('absl.status_rpc', '0', true);

  RETURN locked_ticket;
END;
$$;
