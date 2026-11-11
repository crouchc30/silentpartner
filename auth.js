/* Accounts: the shared link word, then a real account per person.
 *
 * Two different things guard this site and it is worth keeping them apart.
 *
 * The link word (config.linkWord) is a doorbell. It keeps the sign-up page from being the
 * first thing a stranger who stumbles on the URL sees. It is checked in the browser, it is
 * in this file, and anyone who reads the page source can find it. It protects nothing and
 * is not meant to.
 *
 * The account is the lock. Email and password, checked by Supabase, and the books cannot be
 * read without one -- that rule lives in the database (row-level security), not here, so
 * editing this file in a browser gets a person nothing.
 */
(function () {
  const cfg = window.SP_CONFIG || {};
  const GATE_KEY = "sp.gate.v1";

  let client = null;
  function db() {
    if (!client) {
      if (!window.supabase) throw new Error("supabase library did not load");
      client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnon, {
        auth: { persistSession: true, autoRefreshToken: true },
      });
    }
    return client;
  }

  // ---- the doorbell -------------------------------------------------------
  // A site can switch the doorbell off entirely by leaving linkWord empty, which is what a
  // site being advertised to strangers wants: making people guess a word before they are even
  // allowed to see a sign-up form costs real users and stops nobody.
  function gateNeeded() { return !!String(cfg.linkWord || "").trim(); }
  function gatePassed() { return !gateNeeded() || localStorage.getItem(GATE_KEY) === "1"; }
  function tryGate(word) {
    const ok = String(word || "").trim().toLowerCase() === String(cfg.linkWord).toLowerCase();
    if (ok) localStorage.setItem(GATE_KEY, "1");
    return ok;
  }

  // ---- accounts -----------------------------------------------------------
  async function signUp(email, password) {
    const { data, error } = await db().auth.signUp({
      email: email.trim(),
      password,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
    // Supabase returns a user with no session when confirmation email is on.
    return { user: data.user, needsConfirm: !data.session };
  }

  async function signIn(email, password) {
    const { data, error } = await db().auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw error;
    return data.user;
  }

  async function signOut() {
    try { await db().auth.signOut(); } finally { location.reload(); }
  }

  /* Codes, not links.
   *
   * Some mail readers will not open a link in a message, and a link that has to survive being
   * forwarded, copied out of a phone and pasted into a different browser is a lot of ways to
   * fail. A code works anywhere a person can read six characters and type them back.
   *
   * The length is whatever the Supabase project is set to -- six to ten digits, and newer
   * projects default to eight -- so nothing here assumes a number. Anything non-numeric is
   * stripped, because people paste codes with spaces in them.
   */
  function cleanCode(code) { return String(code || "").replace(/\D/g, ""); }

  // GoTrue has taken different names for these over time and the docs disagree with
  // themselves, so try the specific one and fall back to the generic.
  async function verifyCode(email, code, kind) {
    const token = cleanCode(code);
    const types = kind === "recovery" ? ["recovery", "email"] : ["signup", "email"];
    let lastErr = null;
    for (const type of types) {
      const { data, error } = await db().auth.verifyOtp({ email: email.trim(), token, type });
      if (!error) return data;
      lastErr = error;
      // A wrong or stale code is a real answer; only a complaint about the type is worth retrying.
      if (!/type/i.test(String(error.message || ""))) break;
    }
    throw lastErr;
  }

  async function resendCode(email, kind) {
    if (kind === "recovery") return sendReset(email);
    const { error } = await db().auth.resend({ type: "signup", email: email.trim() });
    if (error) throw error;
  }

  // The forgot-password mail. Supabase sends it; with the template below it carries a code.
  async function sendReset(email) {
    const base = location.origin + location.pathname.replace(/[^/]*$/, "");
    // redirectTo still set, so a link in an older template keeps working for anybody who
    // already has one in their inbox.
    const { error } = await db().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: base + "reset.html",
    });
    if (error) throw error;
  }

  // Used by reset.html once the emailed link has signed the person in.
  async function setPassword(password) {
    const { error } = await db().auth.updateUser({ password });
    if (error) throw error;
  }

  async function currentUser() {
    const { data } = await db().auth.getSession();
    return data.session ? data.session.user : null;
  }

  function onAuthChange(fn) { db().auth.onAuthStateChange((_e, s) => fn(s ? s.user : null)); }

  // Friendlier wording than Supabase's own, which talks about "credentials".
  function explain(err) {
    const m = String((err && err.message) || err || "").toLowerCase();
    if (m.includes("invalid login")) return "That email and password don't match an account. Check both, or use “Forgot your password?” below.";
    if (m.includes("already registered")) return "There is already an account with that email. Sign in instead, or reset the password.";
    if (m.includes("password should be")) return "Passwords need to be at least 8 characters. A short phrase works well.";
    if (m.includes("email not confirmed")) return "Check your email and click the link we sent, then sign in.";
    if (m.includes("rate limit") || m.includes("too many")) return "Too many tries just now. Wait a minute and try again.";
    if (m.includes("expired")) return "That code has expired. Press \u201cSend me another code\u201d below.";
    if (m.includes("invalid") && m.includes("token")) return "That code isn\u2019t right. Check the newest email \u2014 asking for another makes the old one stop working.";
    if (m.includes("otp")) return "That code isn\u2019t right, or it has expired. Ask for another below.";
    if (m.includes("failed to fetch") || m.includes("network")) return "Couldn't reach the server. Check the internet connection and try again.";
    return "Something went wrong: " + ((err && err.message) || "unknown error");
  }

  window.SPAuth = {
    db, gateNeeded, gatePassed, tryGate, signUp, signIn, signOut, verifyCode, resendCode, cleanCode,
    sendReset, setPassword, currentUser, onAuthChange, explain,
  };
})();
