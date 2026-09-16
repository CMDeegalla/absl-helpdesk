-- =====================================================================
-- 0014_resolved_notification_content.sql
--
-- Every ticket status change has always emailed the customer (0001's
-- queue_ticket_notification(), fires on every status transition) - but
-- the body was the same generic "Your ticket status changed to
-- resolved." for every status, even though a resolution now carries real
-- information worth telling the customer: the technician's resolution
-- notes and the service call number (0007/0009). This was the one gap
-- left after 0010 already put the same two fields into the CEO Console's
-- resolution receipt - the customer's own notification email never got
-- the same treatment.
--
-- Every other status transition (new -> in_progress, -> closed, etc.)
-- keeps the exact same generic message as before.
--
-- Idempotent: safe to re-run.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.queue_ticket_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_creator_email text;
  v_body text;
BEGIN
  SELECT email INTO v_creator_email
  FROM public.profiles
  WHERE id = NEW.created_by;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.notifications(ticket_id, recipient_profile_id, recipient_email, subject, body)
    VALUES (
      NEW.id,
      NEW.created_by,
      v_creator_email,
      'Ticket created: ' || NEW.ticket_number,
      'Your support ticket was created successfully.'
    );
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'resolved' THEN
      v_body := 'Your ticket has been resolved.';

      IF NEW.resolution_notes IS NOT NULL AND trim(NEW.resolution_notes) <> '' THEN
        v_body := v_body || E'\n\nWhat we did: ' || NEW.resolution_notes;
      END IF;

      IF NEW.service_call_number IS NOT NULL AND trim(NEW.service_call_number) <> '' THEN
        v_body := v_body || E'\n\nService call number: ' || NEW.service_call_number;
      END IF;
    ELSE
      v_body := 'Your ticket status changed to ' || NEW.status::text || '.';
    END IF;

    INSERT INTO public.notifications(ticket_id, recipient_profile_id, recipient_email, subject, body)
    VALUES (
      NEW.id,
      NEW.created_by,
      v_creator_email,
      'Ticket status updated: ' || NEW.ticket_number,
      v_body
    );
  END IF;

  RETURN NEW;
END;
$$;
