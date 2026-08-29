-- ═══════════════════════════════════════════════════════════════════════════
-- RugTown Phase 3c — optional contact email at New Sign Up
--
-- New Sign Up now asks for an email address before the username step. It is
-- NOT used for authentication or verification -- there is no confirmation
-- email, no login-by-email, nothing is ever sent to it. It is stored purely
-- as contact/recovery metadata for a possible future account-recovery
-- feature ("email me my recovery code"), per explicit product request.
-- The account itself is still Supabase anonymous auth + the Phase 3
-- recovery-code system (20260823_phase3_recovery_code_auth.sql) -- this
-- migration does not change how sign-in/sign-up works, only adds a place to
-- store an address alongside the account.
--
-- Deliberately NOT a column on public.profiles: that table has a
-- "profiles: public read" RLS policy (`USING (true)`, defined in
-- database/schema.sql) so that leaderboards/multiplayer can show any
-- player's username/rank/etc to any client, including the anon key with no
-- session at all. Every column on profiles is world-readable. Putting a raw
-- email address there would leak every player's email address to any
-- visitor of the app. This migration instead uses its own table with
-- owner-only RLS (a player can read/write their own row; nobody else can
-- read any row at all, not even via a SECURITY DEFINER function -- there
-- isn't one; plain owner-scoped RLS is sufficient here since, unlike the
-- recovery-code hash, there's no reason to hide the email from its own
-- owner).
--
-- Safe to re-run: CREATE TABLE IF NOT EXISTS / DROP POLICY IF EXISTS +
-- CREATE POLICY throughout. Additive only.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.player_contact_emails (
  player_id  uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  email      text NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.player_contact_emails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "player_contact_emails: owner read own" ON public.player_contact_emails;
CREATE POLICY "player_contact_emails: owner read own"
  ON public.player_contact_emails
  FOR SELECT
  USING (auth.uid() = player_id);

DROP POLICY IF EXISTS "player_contact_emails: owner insert own" ON public.player_contact_emails;
CREATE POLICY "player_contact_emails: owner insert own"
  ON public.player_contact_emails
  FOR INSERT
  WITH CHECK (auth.uid() = player_id);

DROP POLICY IF EXISTS "player_contact_emails: owner update own" ON public.player_contact_emails;
CREATE POLICY "player_contact_emails: owner update own"
  ON public.player_contact_emails
  FOR UPDATE
  USING     (auth.uid() = player_id)
  WITH CHECK (auth.uid() = player_id);

-- No DELETE policy -- an email is replaced via UPSERT (ON CONFLICT), never
-- removed independently of the account it belongs to (which cascades via
-- ON DELETE CASCADE above if the profile itself is ever deleted).

COMMENT ON TABLE public.player_contact_emails IS
  'Phase 3c -- optional contact email captured at New Sign Up. Never used for authentication/verification, no email is ever sent to it. Kept off public.profiles (which is world-readable) so it is never exposed to other players; owner-only RLS.';
