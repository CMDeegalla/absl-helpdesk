-- =====================================================================
-- 0012_audit_fixes_round2.sql
--
-- Three real defects found in a follow-up 10-angle automated review of
-- everything built since the previous audit (0007-0010):
--
--   1. add_progress_photo() compared assigned_technician_id <> auth.uid()
--      directly. When a ticket is unclaimed, assigned_technician_id is
--      NULL, and NULL <> anything evaluates to NULL, which an IF treats
--      as false - the "only your own job" check silently never fired for
--      an unclaimed ticket. Any technician could call this RPC against
--      any unclaimed ticket, attach a photo and post a public comment on
--      a job that was not theirs, despite the function's own error
--      message claiming otherwise.
--
--   2. report_search()'s customer/service-call filters spliced raw user
--      input into an ILIKE pattern with no escaping. A literal '%' or '_'
--      in a search term (e.g. an email like jane_silva@absl.lk) silently
--      widened the match instead of searching for it literally.
--
--   3. report_search()'s date range compared a plain `date` against
--      `created_at timestamptz` with no timezone pinned, so the
--      boundary landed at midnight UTC instead of midnight in Sri Lanka
--      (UTC+5:30) - a "From/To" search for one calendar day could miss
--      or wrongly include tickets near the day boundary.
--
-- Idempotent: safe to re-run.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. add_progress_photo(): IS DISTINCT FROM instead of <>, so NULL
--    (unclaimed) is handled the same as any other mismatch.
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

  -- IS DISTINCT FROM treats NULL as a real value to compare, unlike <>,
  -- which returns NULL (never true) whenever either side is NULL. An
  -- unclaimed ticket has assigned_technician_id = NULL, so the old <>
  -- comparison silently let any technician through here.
  IF public.current_role() = 'technician'
     AND v_ticket.assigned_technician_id IS DISTINCT FROM auth.uid()
  THEN
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
-- 2 & 3. report_search(): escape literal %/_ (and the escape character
--    itself) before building an ILIKE pattern, and pin the date-range
--    comparison to the business timezone instead of the session default.
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_pattern text;
  v_service_call_pattern text;
BEGIN
  -- Escape the ILIKE special characters in the raw search text itself, so
  -- a literal '%', '_' or '\' the user typed is matched literally instead
  -- of acting as a wildcard. '%' and '_' become the search term; '%'/'_'
  -- surrounding them make it a "contains" search, same as before.
  IF p_customer_query IS NOT NULL AND trim(p_customer_query) <> '' THEN
    v_customer_pattern := '%' || replace(replace(replace(p_customer_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  IF p_service_call_number IS NOT NULL AND trim(p_service_call_number) <> '' THEN
    v_service_call_pattern := '%' || replace(replace(replace(p_service_call_number, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  RETURN QUERY
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
  WHERE public.current_role() IN ('agent', 'admin')
    AND (
      v_customer_pattern IS NULL
      OR cust.full_name ILIKE v_customer_pattern
      OR cust.email ILIKE v_customer_pattern
      OR comp.name ILIKE v_customer_pattern
    )
    AND (
      v_service_call_pattern IS NULL
      OR t.service_call_number ILIKE v_service_call_pattern
    )
    -- Pinned to the business timezone (Sri Lanka, UTC+5:30) rather than
    -- whatever the database session's default happens to be, so a
    -- "From X To X" search matches the calendar day staff actually mean.
    AND (p_date_from IS NULL OR t.created_at >= (p_date_from::timestamp AT TIME ZONE 'Asia/Colombo'))
    AND (p_date_to IS NULL OR t.created_at < ((p_date_to + 1)::timestamp AT TIME ZONE 'Asia/Colombo'))
  ORDER BY t.created_at DESC
  LIMIT 500;
END;
$$;
