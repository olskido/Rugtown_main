/**
 * finalize-reward-epochs — scheduled maintenance.
 * Finalizes ended epochs idempotently and ensures today's epoch exists.
 * Service-role only (invoke via Supabase cron or operator).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handlePreflight } from '../_shared/cors.ts';
import { jsonResponse, errorResponse } from '../_shared/errors.ts';
import { requireEnv } from '../_shared/env.ts';

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  try {
    const url = requireEnv('SUPABASE_URL');
    const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const authHeader = req.headers.get('Authorization') ?? '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (bearer !== key) {
      return errorResponse(req, 'forbidden', 'Service role required', 403);
    }

    const admin = createClient(url, key);
    const { data, error } = await admin.rpc('run_reward_epoch_maintenance');
    if (error) {
      return jsonResponse(req, { ok: false, error: error.message }, 400);
    }
    return jsonResponse(req, { ok: true, ...data });
  } catch (e) {
    return jsonResponse(req, {
      ok: false,
      error: e instanceof Error ? e.message : 'error',
    }, 500);
  }
});
