-- =====================================================================
-- 0027_no_self_emails_for_staff_jobs.sql
--
-- queue_ticket_notification() emails a ticket's creator "your ticket was
-- created" and "your ticket status changed" - right for a customer, wrong
-- when the creator is ABSL staff. 0017 skipped staff-logged jobs by
-- checking caller_name IS NOT NULL, which covered phone-in jobs only.
-- 0025 added self-jobs ("this is my own job, nobody called"): those have
-- no caller, so the check missed them and the technician, agent, operator
-- or admin who logged one got emailed about their own internal job.
--
-- The guard now also skips any ticket whose creator is staff. Customer-
-- raised tickets are untouched and still get every email, including the
-- resolved email with resolution notes and service call number.
--
-- Everything below the guard is 0017's version, unchanged.
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
  IF NEW.caller_name IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.profiles
       WHERE id = NEW.created_by
         AND role <> 'customer'
     )
  THEN
    RETURN NEW;
  END IF;

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
