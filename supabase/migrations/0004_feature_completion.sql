-- =====================================================================
-- 0004_feature_completion.sql
--
-- Completes the Phase 1 workflows that were documented in the sequence
-- diagrams but had no implementation behind them, and adds the indexes,
-- audit trail and notification coverage a production system needs.
--
--   Diagram 6  Callback request flow          -> request_callback() / complete_callback()
--   Diagram 8  Status notifications            -> assignment + comment notifications
--   Diagram 9  Location tracking               -> lat/lng captured, accuracy stored
--   Diagram 12 Technician reassignment         -> reassign_ticket()
--   Diagram 10 Ticket detail with attachments  -> attachment metadata + staff directory
--
-- Idempotent: safe to re-run.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Performance. Every list in the app filters on these columns and the
--    tables had no index beyond the primary keys.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS tickets_company_status_idx
  ON public.tickets (company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS tickets_created_by_idx
  ON public.tickets (created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS tickets_technician_idx
  ON public.tickets (assigned_technician_id, status)
  WHERE assigned_technician_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ticket_comments_ticket_idx
  ON public.ticket_comments (ticket_id, created_at);

CREATE INDEX IF NOT EXISTS ticket_attachments_ticket_idx
  ON public.ticket_attachments (ticket_id);

CREATE INDEX IF NOT EXISTS ticket_status_history_ticket_idx
  ON public.ticket_status_history (ticket_id, created_at DESC);

CREATE INDEX IF NOT EXISTS callback_requests_status_idx
  ON public.callback_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_movements_item_idx
  ON public.inventory_movements (inventory_item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS profiles_role_idx
  ON public.profiles (role, approval_status);


-- ---------------------------------------------------------------------
-- 2. Data quality. Free-text fields had no bound at all, so a paste of a
--    whole document would land in the database and then in an email.
--
--    Existing rows are normalised FIRST. A CHECK constraint is validated
--    against every row already in the table, so adding one to a table that
--    holds test data written before the rule existed aborts the whole
--    migration — which is exactly what happened on the first attempt.
-- ---------------------------------------------------------------------

-- Priority: the app writes lowercase, but earlier builds and hand-inserted
-- test rows used 'High' / 'Medium' / NULL.
UPDATE public.tickets
SET priority = lower(trim(priority))
WHERE priority IS DISTINCT FROM lower(trim(priority));

UPDATE public.tickets
SET priority = 'medium'
WHERE priority IS NULL OR priority NOT IN ('high', 'medium', 'low');

-- Title: pad anything too short, trim anything too long.
UPDATE public.tickets
SET title = left(title, 200)
WHERE char_length(title) > 200;

UPDATE public.tickets
SET title = rpad(coalesce(nullif(trim(title), ''), 'Untitled ticket'), 3, '.')
WHERE title IS NULL OR char_length(trim(title)) < 3;

-- Description: early tickets were created with the title as the description,
-- and some with nothing at all.
UPDATE public.tickets
SET description = left(description, 5000)
WHERE char_length(description) > 5000;

UPDATE public.tickets
SET description = coalesce(nullif(trim(description), ''), title)
WHERE description IS NULL OR trim(description) = '';

UPDATE public.ticket_comments
SET body = left(body, 4000)
WHERE char_length(body) > 4000;

DELETE FROM public.ticket_comments
WHERE body IS NULL OR trim(body) = '';

-- Coordinates: drop anything outside the real range rather than fail on it.
UPDATE public.tickets
SET location_lat = NULL, location_lng = NULL
WHERE (location_lat IS NOT NULL AND location_lat NOT BETWEEN -90 AND 90)
   OR (location_lng IS NOT NULL AND location_lng NOT BETWEEN -180 AND 180);

-- Now the rules can be added safely.
ALTER TABLE public.tickets
  DROP CONSTRAINT IF EXISTS tickets_title_length;
ALTER TABLE public.tickets
  ADD CONSTRAINT tickets_title_length
  CHECK (char_length(title) BETWEEN 3 AND 200);

ALTER TABLE public.tickets
  DROP CONSTRAINT IF EXISTS tickets_description_length;
ALTER TABLE public.tickets
  ADD CONSTRAINT tickets_description_length
  CHECK (char_length(description) BETWEEN 1 AND 5000);

ALTER TABLE public.tickets
  DROP CONSTRAINT IF EXISTS tickets_priority_values;
ALTER TABLE public.tickets
  ADD CONSTRAINT tickets_priority_values
  CHECK (priority IN ('high', 'medium', 'low'));

ALTER TABLE public.ticket_comments
  DROP CONSTRAINT IF EXISTS ticket_comments_body_length;
ALTER TABLE public.ticket_comments
  ADD CONSTRAINT ticket_comments_body_length
  CHECK (char_length(body) BETWEEN 1 AND 4000);

-- Coordinates, when supplied, must be real coordinates.
ALTER TABLE public.tickets
  DROP CONSTRAINT IF EXISTS tickets_latitude_range;
ALTER TABLE public.tickets
  ADD CONSTRAINT tickets_latitude_range
  CHECK (location_lat IS NULL OR location_lat BETWEEN -90 AND 90);

ALTER TABLE public.tickets
  DROP CONSTRAINT IF EXISTS tickets_longitude_range;
ALTER TABLE public.tickets
  ADD CONSTRAINT tickets_longitude_range
  CHECK (location_lng IS NULL OR location_lng BETWEEN -180 AND 180);

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS location_accuracy_m numeric;


-- ---------------------------------------------------------------------
-- 3. Attachment metadata, so the UI can show a size and pick a viewer
--    instead of guessing from the file extension.
-- ---------------------------------------------------------------------
ALTER TABLE public.ticket_attachments
  ADD COLUMN IF NOT EXISTS file_size bigint,
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS original_name text;


-- ---------------------------------------------------------------------
-- 4. Staff directory.
--    Customers must see "Nuwan (Agent)" on a reply instead of
--    "Team member", but they must not be able to read the profiles table.
--    A view exposes exactly three columns and nothing else.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.staff_directory AS
  SELECT id, full_name, role
  FROM public.profiles
  WHERE role <> 'customer'
    AND approval_status = 'approved';

GRANT SELECT ON public.staff_directory TO authenticated;


-- ---------------------------------------------------------------------
-- 5. Diagram 6 — callback requests.
--    The tickets table had a wants_callback flag and nothing else; there
--    was no queue for an agent to work through.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_callback(
  p_ticket_id uuid,
  p_phone text
)
RETURNS public.callback_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.callback_requests;
BEGIN
  IF NOT public.can_view_ticket(p_ticket_id) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF coalesce(trim(p_phone), '') = '' THEN
    RAISE EXCEPTION 'A phone number is required for a callback.';
  END IF;

  -- One open callback per ticket; asking twice updates the number.
  SELECT * INTO v_row
  FROM public.callback_requests
  WHERE ticket_id = p_ticket_id AND status = 'pending'
  LIMIT 1;

  IF FOUND THEN
    UPDATE public.callback_requests
    SET phone = trim(p_phone)
    WHERE id = v_row.id
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.callback_requests (ticket_id, requested_by, phone, status)
    VALUES (p_ticket_id, auth.uid(), trim(p_phone), 'pending')
    RETURNING * INTO v_row;
  END IF;

  PERFORM set_config('absl.status_rpc', '1', true);
  UPDATE public.tickets SET wants_callback = true WHERE id = p_ticket_id;
  PERFORM set_config('absl.status_rpc', '0', true);

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_callback(
  p_callback_id uuid,
  p_note text DEFAULT NULL
)
RETURNS public.callback_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.callback_requests;
BEGIN
  IF public.current_role() NOT IN ('agent', 'admin') THEN
    RAISE EXCEPTION 'Only an agent or admin can complete a callback.';
  END IF;

  UPDATE public.callback_requests
  SET status = 'completed',
      completed_by = auth.uid(),
      completed_at = now()
  WHERE id = p_callback_id
    AND status = 'pending'
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Callback request not found, or it was already completed.';
  END IF;

  PERFORM set_config('absl.status_rpc', '1', true);
  UPDATE public.tickets SET wants_callback = false WHERE id = v_row.ticket_id;
  PERFORM set_config('absl.status_rpc', '0', true);

  INSERT INTO public.ticket_comments (ticket_id, author_id, body)
  VALUES (
    v_row.ticket_id,
    auth.uid(),
    'Callback completed by phone.' ||
      CASE WHEN coalesce(trim(p_note), '') = '' THEN '' ELSE ' Note: ' || trim(p_note) END
  );

  INSERT INTO public.audit_logs (actor_id, action, record_table, record_id, metadata)
  VALUES (auth.uid(), 'callback.completed', 'callback_requests', v_row.id,
          jsonb_build_object('ticket_id', v_row.ticket_id));

  RETURN v_row;
END;
$$;


-- ---------------------------------------------------------------------
-- 6. Diagram 12 — assignment and reassignment.
--    Assignment used to be a bare UPDATE from the browser with no audit
--    trail and no notification to the technician picking up the job.
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

  INSERT INTO public.audit_logs (actor_id, action, record_table, record_id, metadata)
  VALUES (auth.uid(), 'ticket.reassigned', 'tickets', p_ticket_id,
          jsonb_build_object('from', v_previous, 'to', p_technician_id, 'reason', p_reason));

  RETURN v_ticket;
END;
$$;


-- ---------------------------------------------------------------------
-- 7. Notify the customer when someone replies (Diagram 7).
--    Only ticket creation and status changes were covered before.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.queue_comment_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.tickets;
  v_author text;
  v_recipient uuid;
  v_email text;
BEGIN
  SELECT * INTO v_ticket FROM public.tickets WHERE id = NEW.ticket_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_author FROM public.profiles WHERE id = NEW.author_id;

  -- A reply goes to the other side of the conversation.
  IF NEW.author_id = v_ticket.created_by THEN
    v_recipient := v_ticket.assigned_agent_id;
  ELSE
    v_recipient := v_ticket.created_by;
  END IF;

  IF v_recipient IS NULL OR v_recipient = NEW.author_id THEN
    RETURN NEW;
  END IF;

  SELECT email INTO v_email FROM public.profiles WHERE id = v_recipient;
  IF v_email IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (
    ticket_id, recipient_profile_id, recipient_email, channel, subject, body
  )
  VALUES (
    NEW.ticket_id,
    v_recipient,
    v_email,
    'email',
    'New reply on ' || v_ticket.ticket_number,
    coalesce(v_author, 'Someone') || ' replied: ' || left(NEW.body, 500)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS queue_comment_notification ON public.ticket_comments;
CREATE TRIGGER queue_comment_notification
  AFTER INSERT ON public.ticket_comments
  FOR EACH ROW EXECUTE FUNCTION public.queue_comment_notification();


-- ---------------------------------------------------------------------
-- 8. Audit trail on the things that matter, so "who closed this ticket
--    and when" has an answer that does not depend on the UI.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_ticket_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.audit_logs (actor_id, action, record_table, record_id, metadata)
    VALUES (NEW.created_by, 'ticket.created', 'tickets', NEW.id,
            jsonb_build_object('ticket_number', NEW.ticket_number, 'priority', NEW.priority));
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.audit_logs (actor_id, action, record_table, record_id, metadata)
    VALUES (auth.uid(), 'ticket.status_changed', 'tickets', NEW.id,
            jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_ticket_insert ON public.tickets;
CREATE TRIGGER audit_ticket_insert
  AFTER INSERT ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.audit_ticket_change();

DROP TRIGGER IF EXISTS audit_ticket_status ON public.tickets;
CREATE TRIGGER audit_ticket_status
  AFTER UPDATE OF status ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.audit_ticket_change();


-- ---------------------------------------------------------------------
-- 9. consume_inventory(): same atomic decrement as 0001, plus an audit
--    entry and a low-stock alert for the admin console.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_inventory(
  p_ticket_id uuid,
  p_inventory_item_id uuid,
  p_quantity integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_quantity integer;
  v_item public.inventory_items;
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;

  IF public.current_role() NOT IN ('technician', 'admin') THEN
    RAISE EXCEPTION 'Only technicians or admins can consume inventory';
  END IF;

  IF p_ticket_id IS NOT NULL AND NOT public.can_view_ticket(p_ticket_id) THEN
    RAISE EXCEPTION 'You can only use parts against your own job.';
  END IF;

  SELECT * INTO v_item
  FROM public.inventory_items
  WHERE id = p_inventory_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory item not found';
  END IF;

  current_quantity := v_item.quantity_on_hand;

  IF current_quantity < p_quantity THEN
    RAISE EXCEPTION 'Insufficient stock: % left', current_quantity;
  END IF;

  UPDATE public.inventory_items
  SET quantity_on_hand = quantity_on_hand - p_quantity
  WHERE id = p_inventory_item_id;

  INSERT INTO public.inventory_movements (
    inventory_item_id, ticket_id, technician_id, movement_type, quantity, note
  )
  VALUES (
    p_inventory_item_id, p_ticket_id, auth.uid(), 'use', -p_quantity,
    'Used from technician Work button'
  );

  INSERT INTO public.audit_logs (actor_id, action, record_table, record_id, metadata)
  VALUES (auth.uid(), 'inventory.consumed', 'inventory_items', p_inventory_item_id,
          jsonb_build_object('quantity', p_quantity, 'ticket_id', p_ticket_id,
                             'remaining', current_quantity - p_quantity));

  -- Warn the admin once, on the crossing, not on every later use.
  IF (current_quantity - p_quantity) <= v_item.reorder_level
     AND current_quantity > v_item.reorder_level THEN
    INSERT INTO public.admin_alerts (alert_type, severity, title, body, related_record_id)
    VALUES ('low_stock', 'warning',
            'Low stock: ' || v_item.name,
            v_item.sku || ' is down to ' || (current_quantity - p_quantity) ||
            ' (reorder level ' || v_item.reorder_level || ').',
            p_inventory_item_id);
  END IF;

  RETURN true;
END;
$$;


-- ---------------------------------------------------------------------
-- 10. One call for the ticket detail screen, so opening a ticket is a
--     single round trip instead of five.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ticket_detail(p_ticket_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.tickets;
  v_result jsonb;
BEGIN
  SELECT * INTO v_ticket FROM public.tickets WHERE id = p_ticket_id;

  IF NOT FOUND OR NOT public.can_view_ticket(v_ticket) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT jsonb_build_object(
    'ticket', to_jsonb(v_ticket),
    'created_by_name', (SELECT full_name FROM public.profiles WHERE id = v_ticket.created_by),
    'company_name', (SELECT name FROM public.companies WHERE id = v_ticket.company_id),
    'attachments', coalesce((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at)
      FROM public.ticket_attachments a WHERE a.ticket_id = p_ticket_id
    ), '[]'::jsonb),
    'history', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'old_status', h.old_status,
          'new_status', h.new_status,
          'created_at', h.created_at,
          'changed_by_name', (SELECT full_name FROM public.profiles WHERE id = h.changed_by)
        ) ORDER BY h.created_at
      )
      FROM public.ticket_status_history h WHERE h.ticket_id = p_ticket_id
    ), '[]'::jsonb),
    'callback', (
      SELECT to_jsonb(c) FROM public.callback_requests c
      WHERE c.ticket_id = p_ticket_id AND c.status = 'pending'
      ORDER BY c.created_at DESC LIMIT 1
    ),
    'parts_used', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'name', i.name, 'sku', i.sku, 'quantity', abs(m.quantity), 'created_at', m.created_at
      ) ORDER BY m.created_at)
      FROM public.inventory_movements m
      JOIN public.inventory_items i ON i.id = m.inventory_item_id
      WHERE m.ticket_id = p_ticket_id
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
