-- =====================================================================
-- 0010_receipt_enrichment.sql
--
-- The auto-generated resolution receipt (0005) captured the ticket,
-- company, customer, technician and parts used - but not the service call
-- number, the technician's resolution notes, or a link to the receipt
-- photo, even though 0007/0009 now require all three before a technician
-- can resolve a ticket. The CEO Console's receipt is the one place all of
-- this should live together for a look-back.
--
-- Idempotent: safe to re-run.
-- =====================================================================

ALTER TABLE public.ticket_receipts
  ADD COLUMN IF NOT EXISTS service_call_number text,
  ADD COLUMN IF NOT EXISTS resolution_notes text,
  ADD COLUMN IF NOT EXISTS receipt_photo_bucket text,
  ADD COLUMN IF NOT EXISTS receipt_photo_path text;

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
  v_receipt_photo public.ticket_attachments;
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

  -- The receipt photo a technician attached in the resolve-ticket form
  -- (0007) - most recent one, in the unlikely event more than one exists.
  SELECT * INTO v_receipt_photo
  FROM public.ticket_attachments
  WHERE ticket_id = NEW.id AND file_type = 'service_receipt'
  ORDER BY created_at DESC
  LIMIT 1;

  INSERT INTO public.ticket_receipts (
    receipt_number, ticket_id, ticket_number, company_name,
    customer_name, customer_email, technician_name, agent_name,
    title, priority, parts_used, created_at_original, resolved_at,
    service_call_number, resolution_notes, receipt_photo_bucket, receipt_photo_path
  )
  VALUES (
    v_receipt_number, NEW.id, NEW.ticket_number, v_company_name,
    v_customer_name, v_customer_email, v_technician_name, v_agent_name,
    NEW.title, NEW.priority, v_parts, NEW.created_at, now(),
    NEW.service_call_number, NEW.resolution_notes,
    v_receipt_photo.bucket_name, v_receipt_photo.file_path
  );

  RETURN NEW;
END;
$$;
