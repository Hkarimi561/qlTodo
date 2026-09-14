/**
 * Copy this file to `environment.ts` (gitignored, so your real values never
 * get committed) and fill it in with your own Supabase project's values
 * (Project Settings -> API in the Supabase dashboard). The anon/public key
 * is safe to ship in a browser bundle — Row Level Security policies decide
 * what it can actually do (see the setup SQL in README.md).
 *
 * The GitHub Pages workflow (.github/workflows/pages.yml) generates the real
 * `environment.ts` at build time from repository secrets instead of reading
 * a committed file — see README.md's GitHub Actions setup section.
 */
export const environment = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-PUBLIC-KEY',
};
