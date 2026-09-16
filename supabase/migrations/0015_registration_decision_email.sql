-- =====================================================================
-- 0015_registration_decision_email.sql
--
-- When an admin approved or rejected a registration, the applicant was
-- never told either way - admin_review_registration() updated the
-- profile and logged an audit entry, but queued no notification. The
-- only way to find out was to try logging in and see what happened.
--
-- Now queues one email to the applicant the moment the decision is
-- made: "you're approved, log in" or "not approved" (with the reason,
-- if one was given).
--
-- Idempotent: safe to re-run.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.admin_review_registration(
  p_profile_id uuid,
  p_approve boolean,
  p_grant_role public.user_role DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile public.profiles;
  v_requested public.user_role;
  v_role public.user_role;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an approved admin can review registrations.';
  END IF;

  SELECT requested_role INTO v_requested
  FROM public.approval_requests
  WHERE profile_id = p_profile_id
  ORDER BY created_at DESC
  LIMIT 1;

  v_role := coalesce(p_grant_role, v_requested, 'customer');

  IF p_approve THEN
    UPDATE public.profiles
    SET approval_status = 'approved',
        role = v_role,
        rejection_reason = NULL
    WHERE id = p_profile_id
    RETURNING * INTO v_profile;
  ELSE
    UPDATE public.profiles
    SET approval_status = 'rejected',
        rejection_reason = p_reason
    WHERE id = p_profile_id
    RETURNING * INTO v_profile;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  UPDATE public.approval_requests
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END::public.approval_status,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      rejection_reason = p_reason
  WHERE profile_id = p_profile_id
    AND status = 'pending';

  INSERT INTO public.audit_logs (actor_id, action, record_table, record_id, metadata)
  VALUES (
    auth.uid(),
    CASE WHEN p_approve THEN 'registration.approved' ELSE 'registration.rejected' END,
    'profiles',
    p_profile_id,
    jsonb_build_object('granted_role', v_role, 'reason', p_reason)
  );

  -- Tell the applicant. Not tied to any ticket (ticket_id is nullable
  -- for exactly this reason), so the notification worker still picks it
  -- up and sends it the same way as every other queued email.
  IF v_profile.email IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_profile_id, recipient_email, subject, body)
    VALUES (
      p_profile_id,
      v_profile.email,
      CASE
        WHEN p_approve THEN 'Your ABSL Helpdesk account has been approved'
        ELSE 'Your ABSL Helpdesk account request was not approved'
      END,
      CASE
        WHEN p_approve THEN
          'Good news - your account has been approved. You can now log in at the helpdesk and start raising tickets.'
        ELSE
          'Your account request was not approved.' ||
          CASE WHEN coalesce(trim(p_reason), '') <> '' THEN ' Reason: ' || trim(p_reason) ELSE '' END
      END
    );
  END IF;

  RETURN v_profile;
END;
$$;
