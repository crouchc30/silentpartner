/* Which Supabase project this copy of the site talks to, and what it calls itself.
 *
 * The anon key below is meant to be public -- it is in every visitor's browser either way.
 * What stops one business reading another's books is the row-level security in
 * supabase/schema.sql, not secrecy about this string. The service-role key is the one that
 * must never appear here; it is not used by the site at all.
 */
window.SP_CONFIG = {
  supabaseUrl:  "https://ryqbuonpqjrihbeawnsf.supabase.co",
  supabaseAnon: "sb_publishable_35tn2ziNS8rz6cAIAQxx6A_cwl3rAgE",

  // The word that opens the front door for anyone with the link, before they
  // have an account. A doorbell, not a lock -- see docs/SETUP.md.
  linkWord: "grassmere",

  shopName: "My Business",
};
