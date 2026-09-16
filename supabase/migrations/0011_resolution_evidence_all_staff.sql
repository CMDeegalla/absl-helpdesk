-- =====================================================================
-- 0011_resolution_evidence_all_staff.sql
--
-- The service call number / resolution notes / receipt photo requirement
-- (0007, 0009) only fired when the account resolving the ticket had
-- role = 'technician'. In practice, whoever actually closes out a job is
-- often an agent or admin - the same person wears different hats, or an
-- admin resolves directly from the CEO Console or the Agent Desk instead
-- of the technician's own login. Both change_ticket_status()'s own
-- server-side check and the resolve-ticket form on the client only ever
-- triggered for the technician role specifically, so any agent/admin
-- resolution silently skipped all three requirements - a ticket could be
-- marked Resolved with no service call number, no resolution notes and no
-- receipt photo, and nothing on screen said why.
--
-- This makes the requirement apply whenever ANYONE resolves a ticket, not
-- only when the resolving account happens to be tagged 'technician'.
-- Customers cannot reach this code path at all (they can only ever close
-- their own ticket, never resolve one - see the is_staff() check earlier
-- in this same function), so "anyone" in practice still means staff.
--
-- Idempotent: safe to re-run.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.change_ticket_status(
  p_ticket_id uuid,
  p_new_status public.ticket_status,
  p_expected_version integer,
  p_service_call_number text DEFAULT NULL,
  p_resolution_notes text DEFAULT NULL
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

  -- Was previously "AND public.current_role() = 'technician'" here - an
  -- agent or admin resolving directly skipped every requirement below.
  -- Only staff can ever reach p_new_status = 'resolved' in the first
  -- place (the is_staff() check above), so no additional role check is
  -- needed to keep customers out of this branch.
  IF p_new_status = 'resolved' THEN
    IF coalesce(trim(p_service_call_number), '') = '' THEN
      RAISE EXCEPTION 'A service call number is required to resolve this ticket.';
    END IF;

    IF coalesce(trim(p_resolution_notes), '') = '' THEN
      RAISE EXCEPTION 'Resolution notes (what you found and what you did) are required to resolve this ticket.';
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
      END,
      resolution_notes = CASE
        WHEN p_new_status = 'resolved' AND p_resolution_notes IS NOT NULL
          THEN trim(p_resolution_notes)
        ELSE resolution_notes
      END
  WHERE id = p_ticket_id
  RETURNING * INTO locked_ticket;

  PERFORM set_config('absl.status_rpc', '0', true);

  RETURN locked_ticket;
END;
$$;
