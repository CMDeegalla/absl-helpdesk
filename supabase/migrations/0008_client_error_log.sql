-- =====================================================================
-- 0008_client_error_log.sql
--
-- The app had no way to find out about a JavaScript error a real user hit
-- unless they happened to report it themselves. This closes that gap
-- without adding a third-party account/SDK: uncaught errors and unhandled
-- promise rejections in the browser are now written to a table here,
-- visible only to admins, the same way admin_alerts already works for
-- server-side problems.
--
-- Deliberately NOT a general-purpose logging pipeline: authenticated users
-- only (an anonymous visitor on the login page hitting an error is lower
-- value and would be an open, unauthenticated write endpoint), one row per
-- error with hard length caps so a broken loop cannot fill the table or
-- balloon storage, and no raw request bodies or tokens ever captured -
-- only a message, a stack trace, the page URL and the browser's user
-- agent string.
--
-- Idempotent: safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.client_error_logs (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete set null,
  message text not null,
  stack text,
  page_url text,
  user_agent text,
  acknowledged boolean not null default false,
  acknowledged_by uuid references public.profiles(id),
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  constraint client_error_logs_message_length check (char_length(message) <= 2000),
  constraint client_error_logs_stack_length check (stack is null or char_length(stack) <= 8000),
  constraint client_error_logs_url_length check (page_url is null or char_length(page_url) <= 500)
);

CREATE INDEX IF NOT EXISTS client_error_logs_created_idx ON public.client_error_logs (created_at DESC);

ALTER TABLE public.client_error_logs ENABLE ROW LEVEL SECURITY;

-- Any signed-in user may report their own error - this is the one write
-- path a real browser needs, and it can only ever attach the reporter's
-- own id, never anyone else's.
DROP POLICY IF EXISTS "Users report their own client errors" ON public.client_error_logs;
CREATE POLICY "Users report their own client errors"
  ON public.client_error_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (profile_id = auth.uid());

-- Only admins can read the log or acknowledge an entry - same visibility
-- rule as admin_alerts.
DROP POLICY IF EXISTS "Admins view client error logs" ON public.client_error_logs;
CREATE POLICY "Admins view client error logs"
  ON public.client_error_logs
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "Admins acknowledge client error logs" ON public.client_error_logs;
CREATE POLICY "Admins acknowledge client error logs"
  ON public.client_error_logs
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
