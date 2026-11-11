/* The books, kept on the server instead of in one browser.
 *
 * The whole set of books travels as one JSON document, the same shape the site has always
 * held in memory, so nothing above this file had to be rewritten. What changed is where it
 * lands: save() used to seal it and put it in localStorage, and now it goes to Supabase.
 *
 * Two people can have the site open at once. Every save carries the version it started from;
 * if someone else saved in between, the server refuses, and we merge their rows with ours
 * (merge.js, the same row-by-row rules the GitHub sync used) and try again. Nobody's entries
 * get wiped by whoever saved second.
 */
(function () {
  let businessId = null;
  let version = 0;
  let lastDoc = null;
  let onRemote = null;

  const sb = () => window.SPAuth.db();

  async function join(shopName) {
    const { data, error } = await sb().rpc("join_shop", { shop_name: shopName || "My Business" });
    if (error) throw error;
    businessId = data;
    return businessId;
  }

  async function load() {
    const { data, error } = await sb()
      .from("books").select("doc, version").eq("business_id", businessId).single();
    if (error) throw error;
    version = Number(data.version) || 0;
    lastDoc = data.doc && Object.keys(data.doc).length ? data.doc : null;
    return lastDoc;
  }

  // Save, and if somebody else got there first, fold their work in and save again.
  async function save(doc, attempt = 0) {
    const { data, error } = await sb().rpc("save_books", {
      bid: businessId, new_doc: doc, expected_version: version,
    });
    if (!error) { version = Number(data); lastDoc = doc; return version; }

    const clash = String(error.message || "").includes("changed on another device");
    if (!clash || attempt >= 3) throw error;

    const theirs = await load();                       // refreshes `version`
    const merged = theirs && window.SPMerge
      ? window.SPMerge.merge(theirs, doc)
      : doc;
    return save(merged, attempt + 1);
  }

  // ---- the History tab ----------------------------------------------------
  async function note(action, detail) {
    const user = await window.SPAuth.currentUser();
    if (!user || !businessId) return;
    // Never let a failed history write stop somebody using the site.
    try {
      await sb().from("history").insert({
        business_id: businessId, user_id: user.id,
        email: user.email, action, detail: detail || null,
      });
    } catch { /* ignore */ }
  }

  async function history(limit = 500) {
    const { data, error } = await sb()
      .from("history").select("email, action, detail, at")
      .eq("business_id", businessId).order("at", { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  }

  async function members() {
    const { data, error } = await sb()
      .from("members").select("email, joined_at").eq("business_id", businessId);
    if (error) throw error;
    return data || [];
  }

  // ---- hearing about other people's saves as they happen ------------------
  function watch(fn) {
    onRemote = fn;
    sb().channel("books-" + businessId)
      .on("postgres_changes",
          { event: "UPDATE", schema: "public", table: "books", filter: "business_id=eq." + businessId },
          payload => {
            const row = payload.new;
            if (Number(row.version) === version) return;   // our own save coming back
            version = Number(row.version);
            lastDoc = row.doc;
            if (onRemote) onRemote(row.doc, row.updated_by);
          })
      .subscribe();
  }

  window.SPCloud = {
    join, load, save, note, history, members, watch,
    businessId: () => businessId,
    version: () => version,
  };
})();
