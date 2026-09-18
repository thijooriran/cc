// App configuration. If either Supabase variable is missing we boot in
// LOCAL-ONLY mode against seeded mock data — the app must demo with no backend.
export const SUPABASE_URL: string | undefined = import.meta.env.VITE_SUPABASE_URL
export const SUPABASE_ANON_KEY: string | undefined = import.meta.env.VITE_SUPABASE_ANON_KEY

export const ONLINE: boolean = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
