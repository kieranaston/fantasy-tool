/**
 * Supabase project settings for multi-device ranking sync.
 *
 * One-time setup (free Supabase project):
 * 1. Create a project at https://supabase.com
 * 2. SQL Editor → run supabase/schema.sql
 * 3. Authentication → Providers → Email enabled
 * 4. Authentication → URL Configuration → add your GitHub Pages URL
 *    (e.g. https://<user>.github.io/fantasy-tool/) to Redirect URLs
 * 5. Paste Project URL + anon/publishable key below
 *
 * The publishable/anon key is safe to commit when Row Level Security is enabled.
 */
export const SUPABASE_URL = "https://vvfpazjspenbtjmnjgwx.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_6jJdu92IBez5Wwst-X9VlA_xUrdg8-V";

export function isSyncConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}
