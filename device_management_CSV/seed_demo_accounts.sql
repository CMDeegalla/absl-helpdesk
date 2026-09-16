-- =====================================================================
-- !! DISABLED — DO NOT USE !!
--
-- This script used to hard-code passwords for a customer, a technician and
-- the CEO admin account, and those passwords were committed to the
-- repository in plain text. That is what this whole file exists to warn
-- you away from — the actual passwords have been removed from here, and the
-- accounts they belonged to have since been reset.
--
-- Use supabase/bootstrap_staff.sql instead: someone signs up through the
-- app choosing their own password, then an admin promotes them by email.
-- No password ever appears in SQL, so there is nothing here to leak.
--
-- This guard is left in place so that if an old copy of the original script
-- ever resurfaces, running it still fails loudly instead of silently
-- setting known passwords on real accounts.
-- =====================================================================

DO $$
BEGIN
  RAISE EXCEPTION 'seed_demo_accounts.sql is disabled. Use supabase/bootstrap_staff.sql.';
END $$;
