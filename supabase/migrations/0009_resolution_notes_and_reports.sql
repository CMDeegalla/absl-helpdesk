-- =====================================================================
-- 0009_resolution_notes_and_reports.sql
--
--   1. A technician's resolution write-up (findings + actions taken +
--      outcome, one field) alongside the service call number from 0007.
--      Visible to the customer once set, same as service_call_number.
--   2. A technician may attach a photo of the fault/issue at any point
--      while a job is theirs, not only in the resolve-ticket form - the
--      existing 'photo' attachment type already covers this, this just
--      adds an RPC so the upload also appends a visible note on the
--      thread instead of silently adding a file nobody is told about.
--   3. report_search(): the query behind the new Reports page - filter by
--      customer, service call number and date range, admin/agent only.
--
-- Idempotent: safe to re-run.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Resolution notes column.
-- ---------------------------------------------------------------------
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS resolution_notes text;


-- ---------------------------------------------------------------------
-- 2. change_ticket_status(): a technician resolving now also requires
--    resolution notes, alongside the service call number and receipt
--    photo from 0007. Same reasoning as 0007 - agents/admins are not
--    gated, they already have full override authority.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.change_ticket_status(uuid, public.ticket_status, integer, text);

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

  IF p_new_status = 'resolved' AND public.current_role() = 'technician' THEN
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


-- ---------------------------------------------------------------------
-- 3. add_progress_photo(): a technician (or any staff) attaches a photo
--    of the fault/issue while the job is still open, and it shows up on
--    the thread as a visible note - the same "don't add a file nobody is
--    told about" reasoning as the hand-off comment in reassign_ticket().
--    The actual file upload still goes through the browser directly to
--    storage, same as every other attachment; this only records the
--    attachment row and the thread note as one step so they cannot drift
--    apart (an upload with no comment, or a comment claiming a photo that
--    failed to attach).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_progress_photo(
  p_ticket_id uuid,
  p_bucket_name text,
  p_file_path text,
  p_file_size bigint,
  p_mime_type text,
  p_original_name text,
  p_note text DEFAULT NULL
)
RETURNS public.ticket_attachments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.tickets;
  v_attachment public.ticket_attachments;
BEGIN
  SELECT * INTO v_ticket FROM public.tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Only ABSL staff can add a progress photo.';
  END IF;

  IF public.current_role() = 'technician' AND v_ticket.assigned_technician_id <> auth.uid() THEN
    RAISE EXCEPTION 'You can only add photos to a job assigned to you.';
  END IF;

  INSERT INTO public.ticket_attachments (
    ticket_id, uploaded_by, bucket_name, file_path, file_type, file_size, mime_type, original_name
  )
  VALUES (
    p_ticket_id, auth.uid(), p_bucket_name, p_file_path, 'photo', p_file_size, p_mime_type, p_original_name
  )
  RETURNING * INTO v_attachment;

  INSERT INTO public.ticket_comments (ticket_id, author_id, body)
  VALUES (
    p_ticket_id,
    auth.uid(),
    coalesce(nullif(trim(p_note), ''), 'Added a photo of the fault/issue.')
  );

  RETURN v_attachment;
END;
$$;


-- ---------------------------------------------------------------------
-- 4. report_search(): the Reports page's query. Admin/agent only - the
--    same audience as the CEO Console panels, not customers or
--    technicians. Returns exactly the columns the report list and its
--    per-ticket summary need, joined once here rather than the client
--    stitching together several separate queries.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_search(
  p_customer_query text DEFAULT NULL,
  p_service_call_number text DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  ticket_number text,
  title text,
  description text,
  status public.ticket_status,
  priority text,
  service_call_number text,
  resolution_notes text,
  resolved_at timestamptz,
  created_at timestamptz,
  customer_name text,
  customer_email text,
  company_name text,
  technician_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    t.id,
    t.ticket_number,
    t.title,
    t.description,
    t.status,
    t.priority,
    t.service_call_number,
    t.resolution_notes,
    (
      SELECT max(h.created_at) FROM public.ticket_status_history h
      WHERE h.ticket_id = t.id AND h.new_status = 'resolved'
    ) AS resolved_at,
    t.created_at,
    cust.full_name AS customer_name,
    cust.email AS customer_email,
    comp.name AS company_name,
    tech.full_name AS technician_name
  FROM public.tickets t
  LEFT JOIN public.profiles cust ON cust.id = t.created_by
  LEFT JOIN public.profiles tech ON tech.id = t.assigned_technician_id
  LEFT JOIN public.companies comp ON comp.id = t.company_id
  -- Agent/admin only, deliberately narrower than is_staff() - a technician
  -- has no need for cross-customer reporting, and their own dashboard
  -- already only shows their own jobs.
  WHERE public.current_role() IN ('agent', 'admin')
    AND (
      p_customer_query IS NULL OR trim(p_customer_query) = ''
      OR cust.full_name ILIKE '%' || p_customer_query || '%'
      OR cust.email ILIKE '%' || p_customer_query || '%'
      OR comp.name ILIKE '%' || p_customer_query || '%'
    )
    AND (
      p_service_call_number IS NULL OR trim(p_service_call_number) = ''
      OR t.service_call_number ILIKE '%' || p_service_call_number || '%'
    )
    AND (p_date_from IS NULL OR t.created_at >= p_date_from)
    AND (p_date_to IS NULL OR t.created_at < p_date_to + INTERVAL '1 day')
  ORDER BY t.created_at DESC
  LIMIT 500;
$$;
