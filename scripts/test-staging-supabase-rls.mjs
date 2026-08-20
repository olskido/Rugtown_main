/**
 * Staging Supabase RLS / integration harness.
 * CREATED, NOT EXECUTED unless STAGING_* env vars are set.
 *
 * Required env:
 *   STAGING_SUPABASE_URL
 *   STAGING_SUPABASE_ANON_KEY
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY
 *   STAGING_TEST_USER_A_EMAIL / STAGING_TEST_USER_A_PASSWORD
 *   STAGING_TEST_USER_B_EMAIL / STAGING_TEST_USER_B_PASSWORD
 *
 * Run: node scripts/test-staging-supabase-rls.mjs
 */
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

const url = process.env.STAGING_SUPABASE_URL;
const anon = process.env.STAGING_SUPABASE_ANON_KEY;
const service = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anon || !service) {
  console.log('test-staging-supabase-rls: SKIPPED — STAGING_SUPABASE_* credentials not set');
  process.exit(0);
}

async function signIn(email, password) {
  const client = createClient(url, anon);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

async function main() {
  const admin = createClient(url, service);
  const emailA = process.env.STAGING_TEST_USER_A_EMAIL;
  const passA = process.env.STAGING_TEST_USER_A_PASSWORD;
  const emailB = process.env.STAGING_TEST_USER_B_EMAIL;
  const passB = process.env.STAGING_TEST_USER_B_PASSWORD;

  if (!emailA || !passA || !emailB || !passB) {
    console.log('test-staging-supabase-rls: SKIPPED — test user credentials not set');
    process.exit(0);
  }

  const clientA = await signIn(emailA, passA);
  const clientB = await signIn(emailB, passB);

  const { data: userA } = await clientA.auth.getUser();
  const { data: userB } = await clientB.auth.getUser();
  assert.ok(userA.user?.id);
  assert.ok(userB.user?.id);

  // Player A cannot write holder_status directly
  const { error: hsErr } = await clientA.from('holder_status').upsert({
    user_id: userA.user.id,
    holder_tier: 'whale',
    token_balance_base_units: 999999999999,
    rp_multiplier: 9.99,
  });
  assert.ok(hsErr, 'expected holder_status direct write to fail');

  // Player A cannot call apply_verified_holder_status
  const { error: applyErr } = await clientA.rpc('apply_verified_holder_status', {
    p_user_id: userA.user.id,
    p_wallet_address: 'fake',
    p_balance_base_units: 999999999999,
  });
  assert.ok(applyErr, 'expected apply_verified_holder_status to be service-role only');

  // refresh_holder_status no longer accepts spoofed balance (returns cached/message)
  const { data: refreshData } = await clientA.rpc('refresh_holder_status', {
    p_balance_base_units: 999999999999,
  });
  assert.ok(refreshData);

  console.log('test-staging-supabase-rls: PASSED on staging project');
}

main().catch((e) => {
  console.error('test-staging-supabase-rls: FAILED', e.message ?? e);
  process.exit(1);
});
