/* Silent Partner: a back-office helper for any small business.
 *
 * Ported from the ENT 1000 Harness v1 (silent-partner-harness/). The rules carry over:
 *   1. Show the reserve, and push back when an amount is too risky.
 *   2. No guessing: every dollar comes from forecast(), which is the only place money math happens.
 *   3. Never move money or send anything. It drafts and flags; the owner decides.
 *   4. Plain language.
 * Everything is stored in this browser (localStorage). Nothing leaves the device.
 */

const STEP_MONTHS = { monthly: 1, quarterly: 3, annual: 12 };
// Your business's own list, from the October 2026 session with the store manager. The shop pays
// no rent or insurance, and printing is part of what the inventory costs, so those are not here.
// "Taxes" is split into the two unrelated kinds she actually files: income tax the shop owes, and
// sales tax it collects for the state. "Donations" is "distribution", because the owners
// owns the shop -- the year-end check is its share, not a gift.
const DEFAULT_CATS = ["Stock and supplies", "Rent", "Utilities", "Wages", "Insurance",
  "Fees and licences", "Marketing", "Repairs", "Equipment", "Software", "Taxes", "Other",
  "End-of-year payout: owners", "End-of-year payout: managers"];

// ---------- dates & money ----------
function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function parseISO(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function toISO(dt) { return dt.toISOString().slice(0, 10); }
function addDays(s, n) { const d = parseISO(s); d.setUTCDate(d.getUTCDate() + n); return toISO(d); }
function addMonths(s, n) {
  const d = parseISO(s);
  const m = d.getUTCMonth() + n;
  return toISO(new Date(Date.UTC(d.getUTCFullYear() + Math.floor(m / 12), ((m % 12) + 12) % 12, Math.min(d.getUTCDate(), 28))));
}
function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }
function nice(s) {
  const d = parseISO(s);
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "no date";
}
function niceLong(s) {
  const d = parseISO(s);
  return d ? d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : "";
}
function money(x) {
  const r = Math.round(x);
  return (r < 0 ? "-$" : "$") + Math.abs(r).toLocaleString("en-US");
}
function cents(x) {
  return "$" + Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function hasAmount(r) { return r.amount !== null && r.amount !== "" && !isNaN(r.amount); }

// ---------- row identity, so two devices' books can be merged ----------
// Every row created from here on carries a uid of its own and the moment it was last touched.
// merge.js uses both: the uid to recognise the same row arriving from another device, the
// timestamp to settle it when the row was edited in two places. Rows written before sync existed
// are deliberately left alone: giving them uids now would stop them matching the other device's
// copy of the very same row, and they'd double up.
function newUid() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}
function stamp(row) { row.touched = new Date().toISOString(); return row; }
function fresh(row) { row.uid = newUid(); return stamp(row); }

// Deleting leaves a marker behind. Without one, the other device still has the row and would
// hand it straight back the next time the books are merged.
function bury(collection, row) {
  if (!row) return;
  if (!state.deleted) state.deleted = {};
  state.deleted[SPMerge.keyOf(collection, row)] = new Date().toISOString();
}

// ---------- a new set of books ----------
// There is no sample data in this site, sealed or otherwise. The only numbers it can ever show
// are the ones somebody typed in themselves.

// Which pages this business wants. Home, History and Settings are not in here: Home is where
// the number lives, History is the record, and Settings is how you get any of the others back.
const DEFAULT_TABS = { afford: true, club: true, mgmt: true, expenses: true, money: true, update: true, pricing: true };

function freshState() {
  return {
    settings: {
      name: "My Business", type: "Retail shop", goal: "", reserve: 1500, horizon: 90, caution: 75,
      big: 1000, dupDays: 3, categories: DEFAULT_CATS.slice(), nextYearInv: 0, mgmtPct: 0,
      tabs: Object.assign({}, DEFAULT_TABS),
    },
    ledger: [], nextId: 1, cash: [], sales: [], recurring: [], nextRecId: 1,
    mgmt: [], nextMgmtId: 1, deleted: {},
  };
}

// Books sealed by an earlier version of the site are missing the year-end fields. Fill them in as
// soon as they're opened, so nothing downstream has to keep testing for them.
function normalizeState(st) {
  const s = st.settings || (st.settings = {});
  if (s.nextYearInv == null) s.nextYearInv = 0;
  if (s.mgmtPct == null) s.mgmtPct = 0;
  if (!Array.isArray(s.categories) || !s.categories.length) s.categories = DEFAULT_CATS.slice();
  if (!Array.isArray(st.mgmt)) st.mgmt = [];
  if (!st.nextMgmtId) st.nextMgmtId = st.mgmt.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;
  if (!st.deleted || typeof st.deleted !== "object") st.deleted = {};
  // A site that gained a page after these books were made should show it, not hide it.
  s.tabs = Object.assign({}, DEFAULT_TABS, s.tabs || {});
  // The sample-number walkthrough has been removed. Books that still carry it, from a browser
  // that loaded the demo back when it existed, are emptied the moment they're opened: the whole
  // point of this version is that every figure in it is real. The set-up is kept, so nobody has
  // to configure the shop again.
  if (st.demo) {
    st.ledger = []; st.cash = []; st.sales = []; st.recurring = []; st.mgmt = [];
    st.nextId = 1; st.nextRecId = 1; st.nextMgmtId = 1; st.deleted = {};
    delete st.demo;
    st.clearedDemo = true; // so the page can say so, once
  }
  return st;
}

// ---------- where the books live ----------
// They used to be encrypted in this one browser. They now live in a Supabase project that only
// this business's accounts can read, which is what lets Mollie and Shelly open the same books
// from different devices and what makes a password someone forgot recoverable by email.
//
// Everything above this line still works on one plain `state` object, exactly as before. The
// only thing that changed is where save() puts it.

const IDLE_LOCK_MS = 60 * 60 * 1000;   // an hour; a shared shop computer, not a bank

let state = null;
let session = null;        // { user } while signed in
let saving = Promise.resolve();
let saveTimer = null;
let pendingNote = null;

// What the next save should say in History. Collapses a flurry of edits into one honest line.
function noteNext(action, detail) { pendingNote = { action, detail }; }

function save() {
  if (!session || !state) return saving;
  const snapshot = JSON.parse(JSON.stringify(state));
  const note = pendingNote; pendingNote = null;

  saving = saving
    .then(() => SPCloud.save(snapshot))
    .then(() => { if (note) return SPCloud.note(note.action, note.detail); })
    .then(() => { flashSaved("Saved"); })
    .catch(err => {
      const m = String((err && err.message) || "");
      if (m.includes("not a member")) toast("You're signed out. Sign in again to keep working.");
      else toast("Couldn't save just now. Check the internet connection \u2014 your typing is still on screen.");
      flashSaved("Not saved", true);
    });
  return saving;
}

// Typing in a field fires save() on every keystroke in places; don't send one request each.
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
  return saving;
}

function flashSaved(text, bad) {
  const el = document.getElementById("savedBadge");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("bad", !!bad);
  el.classList.remove("hidden");
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => el.classList.add("hidden"), 2500);
}

function localSavedAt() { return ""; }

async function lockNow() {
  await saving;
  await SPCloud.note("signed out", null).catch(() => {});
  await SPAuth.signOut();   // reloads the page, which clears the books from memory
}

// ---------- the ledger guard: flags for the owner ----------
function normVendor(v) { return (v || "").toLowerCase().replace(/'s/g, "s").replace(/[^a-z0-9]/g, ""); }

function flagsFor(row) {
  if (row.ok) return [];
  const s = state.settings;
  const out = [];
  if (row.note) out.push(row.note);
  else {
    const missing = [["date", row.date], ["who was paid", row.vendor], ["category", row.cat], ["amount", hasAmount(row)], ["paid or not", row.status]]
      .filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) out.push("Missing " + missing.join(", "));
  }
  if (row.date && hasAmount(row)) {
    const dup = state.ledger.find(o => o.id < row.id && o.date && hasAmount(o)
      && normVendor(o.vendor) === normVendor(row.vendor)
      && Math.abs(o.amount - row.amount) < 0.01
      && Math.abs(daysBetween(o.date, row.date)) <= s.dupDays);
    if (dup) out.push(`Possible duplicate of #${dup.id} (same place, same amount, ${nice(dup.date)})`);
  }
  if (hasAmount(row) && row.amount >= s.big) out.push(`Big expense (over ${money(s.big)}). Please confirm`);
  return out;
}
function flaggedRows() { return state.ledger.filter(r => flagsFor(r).length); }

// ---------- the forecast: the ONLY place money math happens ----------
function occurrences(item, start, end) {
  const out = [];
  let due = item.due;
  let guard = 0;
  while (due && due <= end && guard++ < 500) {
    if (due >= start) out.push(due);
    if (!STEP_MONTHS[item.freq]) break;
    due = addMonths(due, STEP_MONTHS[item.freq]);
  }
  return out;
}

function forecast(asOf = todayISO(), proposed = null) {
  const s = state.settings;
  const horizon = Number(s.horizon);
  const end = addDays(asOf, horizon);

  const snaps = state.cash.filter(c => c.date <= asOf).sort((a, b) => a.date.localeCompare(b.date));
  const snap = snaps[snaps.length - 1] || null;
  const cash = snap ? Number(snap.balance) : 0;
  const snapDate = snap ? snap.date : null;

  const paidSince = state.ledger.filter(r => r.status === "paid" && hasAmount(r) && r.date && snapDate && r.date > snapDate);
  const unpaid = state.ledger.filter(r => r.status === "unpaid" && hasAmount(r));
  const uncounted = state.ledger.filter(r => !hasAmount(r) || !r.status);

  const recentSales = state.sales.slice().sort((a, b) => a.week.localeCompare(b.week)).slice(-8);
  const weeklyAvg = recentSales.length ? recentSales.reduce((t, r) => t + Number(r.net), 0) / recentSales.length : 0;
  const expectedSales = weeklyAvg * (horizon / 7) * (Number(s.caution) / 100);

  const upcoming = [];
  for (const item of state.recurring) {
    for (const due of occurrences(item, asOf, end)) upcoming.push({ name: item.name, due, amount: Number(item.amount) });
  }
  upcoming.sort((a, b) => a.due.localeCompare(b.due));

  const sum = (arr, f) => arr.reduce((t, x) => t + Number(f(x)), 0);
  const paidSinceTotal = sum(paidSince, r => r.amount);
  const unpaidTotal = sum(unpaid, r => r.amount);
  const upcomingTotal = sum(upcoming, u => u.amount);
  const reserve = Number(s.reserve);
  const safeRaw = cash - paidSinceTotal + expectedSales - unpaidTotal - upcomingTotal - reserve;

  const result = {
    asOf, end, horizon, cash, snapDate, paidSince, paidSinceTotal, weeklyAvg, expectedSales,
    weeksOfSales: recentSales.length, unpaid, unpaidTotal, upcoming, upcomingTotal, reserve,
    safeRaw, safe: Math.max(safeRaw, 0), uncounted,
  };
  if (proposed !== null) {
    const left = safeRaw + reserve - proposed;
    result.proposed = proposed;
    result.left = left;
    result.ok = proposed <= safeRaw;
    result.shortfallBelowReserve = Math.max(reserve - left, 0);
  }
  return result;
}

// Every bill the business is on the hook for (unpaid ledger rows + repeat bills), soonest first.
function billsAhead(f) {
  const fromLedger = f.unpaid.map(r => ({ name: r.vendor || r.desc || "Unnamed bill", detail: r.desc, due: r.due, amount: r.amount }));
  return fromLedger.concat(f.upcoming.map(u => ({ name: u.name, detail: "repeats", due: u.due, amount: u.amount })))
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
}

function dueTag(due) {
  if (!due) return `<span class="tag">no due date</span>`;
  const d = daysBetween(todayISO(), due);
  if (d < 0) return `<span class="tag overdue">overdue ${nice(due)}</span>`;
  if (d === 0) return `<span class="tag overdue">due today</span>`;
  if (d <= 7) return `<span class="tag soon">${nice(due)}</span>`;
  return `<span class="tag">${nice(due)}</span>`;
}

function monthsPhrase(days) {
  const m = Math.round(days / 30);
  if (m <= 1) return days <= 31 ? "next month" : "next " + days + " days";
  return `next ${m} months`;
}

// ---------- rendering ----------
const $ = sel => document.querySelector(sel);

function breakdownHTML(f) {
  const rows = [];
  rows.push(`<tr><td>Money in the bank ${f.snapDate ? `<span class="muted">(as of ${nice(f.snapDate)})</span>` : `<span class="muted">(not entered yet)</span>`}</td><td class="num">${money(f.cash)}</td></tr>`);
  if (f.paidSince.length) {
    rows.push(`<tr><td>Spent since that balance</td><td class="num minus">-${money(f.paidSinceTotal)}</td></tr>`);
    f.paidSince.forEach(r => rows.push(`<tr class="sub"><td>${esc(r.vendor)}, ${nice(r.date)}</td><td class="num">-${money(r.amount)}</td></tr>`));
  }
  rows.push(`<tr><td>Sales we expect over the ${monthsPhrase(f.horizon)} <span class="muted">(${money(f.weeklyAvg)}/week × ${state.settings.caution}%, to be safe)</span></td><td class="num plus">+${money(f.expectedSales)}</td></tr>`);
  rows.push(`<tr><td>Bills you haven't paid yet</td><td class="num minus">-${money(f.unpaidTotal)}</td></tr>`);
  f.unpaid.forEach(r => rows.push(`<tr class="sub"><td>${esc(r.vendor || "?")}: ${esc(r.desc)}${r.due ? `, due ${nice(r.due)}` : ""}</td><td class="num">-${money(r.amount)}</td></tr>`));
  rows.push(`<tr><td>Repeat bills coming due by ${nice(f.end)}</td><td class="num minus">-${money(f.upcomingTotal)}</td></tr>`);
  f.upcoming.forEach(u => rows.push(`<tr class="sub"><td>${esc(u.name)}, ${nice(u.due)}</td><td class="num">-${money(u.amount)}</td></tr>`));
  rows.push(`<tr><td>Cushion always kept for surprises</td><td class="num minus">-${money(f.reserve)}</td></tr>`);
  rows.push(`<tr class="total"><td>Safe to spend or give</td><td class="num">${money(f.safe)}</td></tr>`);
  let html = `<table class="breakdown">${rows.join("")}</table>`;
  if (f.safeRaw < 0) html += `<div class="callout bad">Heads up: your known bills are ${money(-f.safeRaw)} more than you can cover while keeping your cushion. Nothing is safe to spend right now.</div>`;
  if (f.uncounted.length) html += `<div class="callout warn">${f.uncounted.length} item${f.uncounted.length > 1 ? "s aren't" : " isn't"} counted yet because the amount or paid/unpaid is missing. Fix ${f.uncounted.length > 1 ? "them" : "it"} under "Needs your OK."</div>`;
  if (!f.snapDate) html += `<div class="callout warn">Add your bank balance under "Bills &amp; sales" to get a real number.</div>`;
  return html;
}

function renderHome() {
  const f = forecast();
  $("#heroSafe").textContent = money(f.safe);
  $("#heroSub").textContent = `After covering every bill we know about for the ${monthsPhrase(f.horizon)} and keeping ${money(f.reserve)} set aside for surprises.`;

  const flagged = flaggedRows();
  $("#reviewCount").textContent = flagged.length;
  $("#reviewCount").classList.toggle("zero", flagged.length === 0);
  $("#reviewList").innerHTML = flagged.length ? flagged.map(r => `
    <li><div><strong>${esc(r.vendor || "Unknown")}</strong> ${hasAmount(r) ? money(r.amount) : "$?"}
      <div class="meta">${esc(r.desc)}</div>
      <div class="flag-note">${flagsFor(r).map(esc).join(" · ")}</div></div>
      <div class="row-actions">
        <button class="small" data-edit="${r.id}">Fix</button>
        <button class="small" data-ok="${r.id}">Looks right</button>
      </div></li>`).join("")
    : `<li class="empty">All clear. Nothing waiting on you.</li>`;

  const soon = billsAhead(f).filter(b => !b.due || daysBetween(todayISO(), b.due) <= 45);
  $("#upcomingList").innerHTML = soon.length ? soon.map(b => `
    <li><div><strong>${esc(b.name)}</strong><div class="meta">${esc(b.detail === "repeats" ? "Repeat bill" : b.detail)}</div></div>
      <div style="text-align:right"><div class="amt">${money(b.amount)}</div>${dueTag(b.due)}</div></li>`).join("")
    : `<li class="empty">No bills due in the next 45 days.</li>`;

  $("#breakdownHome").innerHTML = breakdownHTML(f);
}

function renderAfford(amount, what) {
  const f = forecast(todayISO(), amount);
  const label = what ? esc(what) : "this";
  const biggest = billsAhead(f).filter(b => b.due && b.due >= todayISO()).sort((a, b) => b.amount - a.amount).slice(0, 3)
    .sort((a, b) => a.due.localeCompare(b.due));
  const billLines = biggest.map(b => `<li>${esc(b.name)}: <strong>${money(b.amount)}</strong> due ${niceLong(b.due)}</li>`).join("");
  const review = flaggedRows().length;
  const reviewNote = review ? `<p><em>${review} item${review > 1 ? "s are" : " is"} still waiting on your OK, so this number could change once ${review > 1 ? "they're" : "it's"} sorted out.</em></p>` : "";

  let html;
  if (f.ok) {
    const room = f.safeRaw - amount;
    html = `<div class="verdict ok">
      <h3>Yes, ${money(amount)} for ${label} looks safe.</h3>
      <p>Safe number today: <strong>${money(f.safe)}</strong>. After ${money(amount)}, you'd still have ${money(room)} of room on top of the ${money(f.reserve)} cushion.</p>
      ${billLines ? `<p>That already covers your biggest bills ahead:</p><ul>${billLines}</ul>` : ""}
      ${reviewNote}
      <p class="decide">Your call. Nothing moves until you move it.</p></div>`;
  } else {
    const middle = Math.max(Math.floor(f.safe / 100) * 100, 0);
    const lastBig = biggest.length ? biggest[biggest.length - 1].due : f.end;
    const revisit = niceLong(lastBig);
    const impact = f.left >= 0
      ? `It would dip ${money(f.reserve - f.left)} into the ${money(f.reserve)} cushion kept for surprises.`
      : `It would use up the whole ${money(f.reserve)} cushion kept for surprises and still leave you <strong>${money(-f.left)} short</strong> on bills.`;
    html = `<div class="verdict no">
      <h3>I'd hold off on ${money(amount)}.</h3>
      <p><strong>${money(f.safe)} is the safe number today.</strong> ${money(amount)} is ${money(amount - f.safe)} more than is safe. ${impact}</p>
      ${billLines ? `<p>The bills at risk:</p><ul>${billLines}</ul>` : ""}
      <p><strong>Middle option:</strong> ${middle > 0 ? `do ${money(middle)} now, then look again after ${revisit}, once those bills are paid.` : `wait until after ${revisit}, once those bills are paid, and check again.`}</p>
      ${reviewNote}
      <p class="decide">Your call. Want to go with ${money(middle)}, or adjust?</p></div>`;
  }
  html += `<div class="card"><h2>The math</h2><p class="muted">Check it yourself. Every line comes from your records.</p>${breakdownHTML(f)}</div>`;
  $("#affordResult").innerHTML = html;
}

// ---------- the year-end distribution ----------
// The owners get what is left at the end of the year, once the business has kept what it needs. Two
// things come off the top before that check can be figured: the money the shop needs to open next
// season without borrowing, and the manager payouts. Whatever survives both is the Club's.
//
// This adds no new money math. It starts from forecast().safe, which has already covered every
// known bill and held back the cushion, and divides it.
function distribution(asOf = todayISO()) {
  const s = state.settings;
  const f = forecast(asOf);
  const nextInv = Math.max(0, Number(s.nextYearInv) || 0);
  const pool = f.safe - nextInv;              // negative means next season isn't covered yet
  const pct = Math.min(100, Math.max(0, Number(s.mgmtPct) || 0));
  const divisible = Math.max(pool, 0);
  const mgmtPool = divisible * (pct / 100);
  return { f, nextInv, pool, divisible, pct, mgmtPool, club: divisible - mgmtPool };
}

// A blank share means "split it evenly". Numbers are weights rather than percentages, so 60 and 40
// divides the pool the same way 6 and 4 does, and nobody has to make the shares add up to 100.
function mgmtSplit(pool) {
  const weights = state.mgmt.map(p => Number(p.share) || 0);
  const total = weights.reduce((t, w) => t + w, 0);
  return state.mgmt.map((p, i) => {
    const frac = total > 0 ? weights[i] / total : (state.mgmt.length ? 1 / state.mgmt.length : 0);
    return { ...p, frac, amount: pool * frac };
  });
}

function distributionRows(d) {
  return `<table class="breakdown">
    <tr><td>Safe to spend or give today</td><td class="num">${money(d.f.safe)}</td></tr>
    <tr><td>Held back to open next season</td><td class="num minus">-${money(d.nextInv)}</td></tr>
    <tr class="total"><td>Left to divide</td><td class="num">${money(d.divisible)}</td></tr>
    <tr><td>Manager payouts <span class="muted">(${d.pct}% of what's left)</span></td><td class="num minus">-${money(d.mgmtPool)}</td></tr>
    <tr class="total"><td>The owners' payout</td><td class="num">${money(d.club)}</td></tr>
  </table>`;
}

function renderClub() {
  const s = state.settings;
  // Don't overwrite a box she's typing in: renderAll() runs after every save, from anywhere.
  if (document.activeElement !== $("#clubInv")) $("#clubInv").value = s.nextYearInv || 0;
  if (document.activeElement !== $("#clubPct")) $("#clubPct").value = s.mgmtPct || 0;

  const d = distribution();
  const short = d.pool < 0;
  const review = flaggedRows().length;

  let html = `<div class="verdict ${short ? "no" : "ok"}">
    <h3>${short
      ? "There isn't a Year-end payout in these numbers yet."
      : `The owners' payout comes to ${money(d.club)}.`}</h3>
    <p>${short
      ? `Opening next season needs ${money(d.nextInv)}, which is ${money(-d.pool)} more than the ${money(d.f.safe)} that's safe today. The shop's own next year has to come first.`
      : `That's what's left after every bill the shop knows about for the ${monthsPhrase(d.f.horizon)}, the ${money(d.f.reserve)} cushion, ${money(d.nextInv)} held back to open next season, and ${money(d.mgmtPool)} for the manager payouts.`}</p>
    ${review ? `<p><em>${review} item${review > 1 ? "s are" : " is"} still waiting on your OK, so this could move once ${review > 1 ? "they're" : "it's"} sorted out.</em></p>` : ""}
    <p class="decide">A recommendation, not a decision. No check is written until you write it.</p></div>`;

  html += `<div class="card"><h2>How that check is figured</h2>${distributionRows(d)}
    <p class="muted" style="margin-top:12px">The first line is the safe number from the home page. This is where <em>that</em> one comes from:</p>
    ${breakdownHTML(d.f)}</div>`;

  $("#clubResult").innerHTML = html;
}

function renderMgmt() {
  const d = distribution();
  const split = mgmtSplit(d.mgmtPool);

  $("#mgmtPoolBox").innerHTML = `<div class="stat-row">
    <div class="stat"><div class="k">Left to divide</div><div class="v">${money(d.divisible)}</div></div>
    <div class="stat"><div class="k">Management's share</div><div class="v">${d.pct}%</div></div>
    <div class="stat"><div class="k">Management pool</div><div class="v">${money(d.mgmtPool)}</div></div>
    <div class="stat"><div class="k">owners' payout</div><div class="v">${money(d.club)}</div></div>
  </div>`;

  $("#mgmtTable").innerHTML = `<thead><tr><th>Who</th><th>Share</th><th style="text-align:right">Their check</th><th></th></tr></thead><tbody>` +
    (split.length ? split.map(p => `<tr>
        <td>${esc(p.name)}</td>
        <td>${p.share ? esc(String(p.share)) : `<span class="muted">even</span>`}
          <span class="muted">(${(p.frac * 100).toFixed(1)}%)</span></td>
        <td class="num">${money(p.amount)}</td>
        <td><button class="small danger" data-delmgmt="${p.id}">✕</button></td></tr>`).join("")
      : `<tr><td colspan="4" class="muted" style="text-align:center;padding:24px">Nobody added yet.</td></tr>`) + "</tbody>";

  $("#mgmtResult").innerHTML = split.length
    ? `<div class="callout good">${split.length} check${split.length > 1 ? "s" : ""} adding up to ${money(split.reduce((t, p) => t + p.amount, 0))}. The remaining ${money(d.club)} is the owners'.</div>`
    : `<div class="callout warn">Add the people who get a year-end check and this works out what each one comes to.</div>`;
}

function catOptions(selected) {
  const cats = state.settings.categories.slice();
  if (selected && !cats.includes(selected)) cats.push(selected);
  return `<option value="">Choose…</option>` + cats.map(c => `<option ${c === selected ? "selected" : ""}>${esc(c)}</option>`).join("");
}

function renderExpenses() {
  if (!$("#exId").value) $("#exCat").innerHTML = catOptions($("#exCat").value);
  const vendors = [...new Set(state.ledger.map(r => r.vendor).filter(Boolean))];
  $("#vendorList").innerHTML = vendors.map(v => `<option value="${esc(v)}">`).join("");

  const filter = $("#filterStatus").value;
  const rows = state.ledger.slice().sort((a, b) => b.id - a.id).filter(r =>
    filter === "all" ? true : filter === "flag" ? flagsFor(r).length : r.status === filter);
  $("#ledgerTable").innerHTML = `<thead><tr><th>#</th><th>Date</th><th>Who</th><th>What</th><th>Category</th><th style="text-align:right">Amount</th><th>Status</th><th></th></tr></thead><tbody>` +
    (rows.length ? rows.map(r => {
      const flags = flagsFor(r);
      const status = r.status === "paid" ? "Paid" : r.status === "unpaid" ? dueTag(r.due) : `<span class="tag overdue">?</span>`;
      return `<tr class="${flags.length ? "flagged" : ""}">
        <td>${r.id}</td><td>${r.date ? nice(r.date) : "<em>?</em>"}</td><td>${esc(r.vendor) || "<em>?</em>"}</td>
        <td>${esc(r.desc)}${flags.length ? `<div class="flag-note">⚑ ${flags.map(esc).join(" · ")}</div>` : ""}</td>
        <td>${esc(r.cat)}</td><td class="num">${hasAmount(r) ? cents(r.amount) : "<em>?</em>"}</td><td>${status}</td>
        <td><div class="row-actions">
          <button class="small" data-edit="${r.id}">Edit</button>
          ${r.status === "unpaid" ? `<button class="small" data-paid="${r.id}">Mark paid</button>` : ""}
          ${flags.length ? `<button class="small" data-ok="${r.id}">Looks right</button>` : ""}
          <button class="small danger" data-del="${r.id}">✕</button>
        </div></td></tr>`;
    }).join("") : `<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">Nothing here yet.</td></tr>`) + "</tbody>";

  const totals = {};
  state.ledger.filter(hasAmount).forEach(r => { totals[r.cat || "Uncategorized"] = (totals[r.cat || "Uncategorized"] || 0) + Number(r.amount); });
  $("#catTotals").innerHTML = Object.entries(totals).sort((a, b) => b[1] - a[1])
    .map(([c, t]) => `<span class="tag">${esc(c)}: ${money(t)}</span>`).join("");
}

function renderMoney() {
  $("#cautionPct").textContent = state.settings.caution + "%";
  $("#recCat").innerHTML = catOptions($("#recCat").value);
  const cash = state.cash.slice().sort((a, b) => b.date.localeCompare(a.date));
  $("#cashList").innerHTML = cash.length ? cash.map((c, i) => `
    <li><span>${nice(c.date)}${i === 0 ? ` <span class="tag">latest</span>` : ""}</span>
    <span><span class="amt">${cents(c.balance)}</span> <button class="small danger" data-delcash="${c.date}">✕</button></span></li>`).join("")
    : `<li class="empty">No balance yet.</li>`;

  const sales = state.sales.slice().sort((a, b) => b.week.localeCompare(a.week));
  $("#salesList").innerHTML = sales.length ? sales.map(s => `
    <li><span>Week ending ${nice(s.week)}</span>
    <span><span class="amt">${cents(s.net)}</span> <button class="small danger" data-delsale="${s.week}">✕</button></span></li>`).join("")
    : `<li class="empty">No sales yet.</li>`;

  const freqLabel = { monthly: "Monthly", quarterly: "Every 3 months", annual: "Yearly", once: "Once" };
  $("#recTable").innerHTML = `<thead><tr><th>Bill</th><th>Category</th><th style="text-align:right">Amount</th><th>Next due</th><th>How often</th><th>Notes</th><th></th></tr></thead><tbody>` +
    (state.recurring.length ? state.recurring.slice().sort((a, b) => a.due.localeCompare(b.due)).map(r => `
      <tr><td>${esc(r.name)}</td><td>${esc(r.cat)}</td><td class="num">${cents(r.amount)}</td><td>${dueTag(r.due)}</td>
      <td>${freqLabel[r.freq] || esc(r.freq)}</td><td class="muted">${esc(r.notes)}</td>
      <td><button class="small danger" data-delrec="${r.id}">✕</button></td></tr>`).join("")
    : `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">No repeat bills yet.</td></tr>`) + "</tbody>";
}

function buildUpdate() {
  const f = forecast();
  const today = todayISO();
  const flagged = flaggedRows();
  const weekAgo = addDays(today, -7);
  const newCount = state.ledger.filter(r => r.added && r.added >= weekAgo).length;
  const bills = billsAhead(f).filter(b => b.due);
  const urgent = bills.filter(b => daysBetween(today, b.due) <= 1);

  const lines = [];
  const opener = [];
  if (newCount) opener.push(`${newCount} new item${newCount > 1 ? "s" : ""} logged`);
  if (flagged.length) opener.push(`${flagged.length} quick question${flagged.length > 1 ? "s" : ""}`);
  lines.push(`Hi! ${opener.length ? opener.join(", ") + " this week." : "Quiet week on the books."}`);
  urgent.forEach(b => {
    const d = daysBetween(today, b.due);
    const when = d < 0 ? `was due ${nice(b.due)}` : d === 0 ? "is due today" : "is due tomorrow";
    lines.push(`Heads up: ${b.name} (${money(b.amount)}) ${when}.`);
  });

  if (flagged.length) {
    lines.push("", "Need your OK:");
    flagged.forEach((r, i) => {
      const what = [r.vendor, r.desc].filter(Boolean).join(", ") || "An item";
      lines.push(`${i + 1}. ${what} (${hasAmount(r) ? money(r.amount) : "$?"}): ${flagsFor(r).join(". ")}`);
    });
  }

  const next = bills.filter(b => b.due >= today).slice(0, 3);
  if (next.length) {
    lines.push("", "Coming up:");
    next.forEach(b => lines.push(`- ${nice(b.due)}: ${b.name}, ${money(b.amount)}`));
  }

  const goal = state.settings.goal ? ` (for ${state.settings.goal})` : "";
  lines.push("", `Safe to spend or give right now${goal}: ${money(f.safe)}. That's after covering the ${monthsPhrase(f.horizon)} of bills and keeping ${money(f.reserve)} set aside.` +
    (f.uncounted.length ? ` (${f.uncounted.length} item${f.uncounted.length > 1 ? "s aren't" : " isn't"} counted yet.)` : ""));
  lines.push("", "Paid for anything else? Snap a photo of the receipt and log it.");
  return lines.join("\n");
}

function renderUpdate(force) {
  const ta = $("#updateText");
  if (force || !ta.dataset.touched) { ta.value = buildUpdate(); ta.dataset.touched = ""; }
  countWords();
}
function countWords() {
  const n = $("#updateText").value.trim().split(/\s+/).filter(Boolean).length;
  $("#wordCount").textContent = `${n} words${n > 180 ? " (a bit long for a text)" : ""}`;
}

function renderPricing() {
  const v = id => Number($(id).value) || 0;
  const mat = v("#prMat"), mins = v("#prMin"), wage = v("#prWage"), over = v("#prOver"), price = v("#prPrice"), target = v("#prTarget");
  const labor = (mins / 60) * wage;
  const cost = mat + labor + over;
  const profit = price - cost;
  const margin = price > 0 ? (profit / price) * 100 : 0;
  const suggested = target < 100 ? cost / (1 - target / 100) : 0;
  const withoutYou = price - mat - over;
  const name = esc($("#prName").value || "this item");

  let call;
  if (profit < 0 && withoutYou > 0) call = `<div class="callout bad">You look profitable on ${name} only because your time is free. Once you pay yourself ${money(wage)}/hour, you <strong>lose ${cents(-profit)}</strong> on every one.</div>`;
  else if (profit < 0) call = `<div class="callout bad">You lose ${cents(-profit)} on every ${name}, even before counting your time.</div>`;
  else if (margin < target) call = `<div class="callout warn">You make ${cents(profit)} each, but that's below your ${target}% goal.</div>`;
  else call = `<div class="callout good">Nice. ${name} covers your materials, overhead, and your time, with ${cents(profit)} left over.</div>`;

  $("#priceResult").innerHTML = `
    <div class="stat-row">
      <div class="stat"><div class="k">True cost</div><div class="v">${cents(cost)}</div></div>
      <div class="stat"><div class="k">Your time</div><div class="v">${cents(labor)}</div></div>
      <div class="stat"><div class="k">Profit each</div><div class="v ${profit < 0 ? "minus" : "plus"}">${cents(profit)}</div></div>
      <div class="stat"><div class="k">Suggested price</div><div class="v">${cents(suggested)}</div></div>
    </div>${call}
    <p class="muted" style="margin-top:12px">Suggested price keeps ${target}% of every sale as profit. True cost = materials ${cents(mat)} + your time ${cents(labor)} + overhead ${cents(over)}.</p>`;
}

function renderSettings() {
  const s = state.settings;
  $("#setName").value = s.name; $("#setType").value = s.type; $("#setGoal").value = s.goal || "";
  $("#setReserve").value = s.reserve; $("#setHorizon").value = s.horizon; $("#setCaution").value = s.caution;
  $("#setBig").value = s.big; $("#setCats").value = s.categories.join(", ");
  const tabBox = $("#tabToggles");
  if (tabBox) {
    const want = s.tabs || DEFAULT_TABS;
    tabBox.innerHTML = Object.keys(DEFAULT_TABS).map(name => {
      const btn = document.querySelector(`#nav button[data-tab="${name}"]`);
      const label = btn ? btn.textContent : name;
      return `<label class="inline"><input type="checkbox" data-tabtoggle="${name}"${want[name] !== false ? " checked" : ""}> ${esc(label)}</label>`;
    }).join("");
  }
  if (session && session.user) $("#setWho").textContent = session.user.email;
  renderMembers();
}

// Who else can open these books. Reassuring to be able to check, and the first place to look
// if a name shows up in History that nobody recognises.
async function renderMembers() {
  const ul = $("#memberList");
  if (!ul) return;
  try {
    const people = await SPCloud.members();
    ul.innerHTML = people.map(m =>
      `<li>${esc(m.email)} <span class="muted">\u2014 joined ${esc(niceLong(m.joined_at))}</span></li>`).join("")
      || "<li class=\"muted\">Just you so far.</li>";
  } catch { ul.innerHTML = ""; }
}

// Hide the pages this business turned off. If somebody is standing on one when it goes, move
// them Home rather than leaving them on a page that is no longer in the menu.
function applyTabs() {
  const want = state.settings.tabs || DEFAULT_TABS;
  let movedOff = false;
  Object.keys(DEFAULT_TABS).forEach(name => {
    const on = want[name] !== false;
    const btn = document.querySelector(`#nav button[data-tab="${name}"]`);
    const sec = document.getElementById("tab-" + name);
    if (btn) btn.classList.toggle("hidden", !on);
    if (sec && !on && sec.classList.contains("active")) movedOff = true;
    if (sec && !on) sec.classList.remove("active");
  });
  if (movedOff) showTab("home");
}

function renderAll() {
  $("#bizName").textContent = state.settings.name;
  applyTabs();
  renderHome(); renderExpenses(); renderMoney(); renderUpdate(); renderPricing(); renderSettings();
  renderClub(); renderMgmt();
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.id === "tab-" + name));
  document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  if (name === "update") renderUpdate();
  if (name === "history") renderHistory();
  window.scrollTo({ top: 0 });
}

// ---------- expense form ----------
function resetExpenseForm() {
  $("#expenseForm").reset();
  $("#exId").value = "";
  $("#exDate").value = todayISO();
  $("#exCat").innerHTML = catOptions("");
  $("#expenseFormTitle").textContent = "Log an expense or bill";
  $("#exSubmit").textContent = "Save expense";
  $("#exCancel").classList.add("hidden");
  $("#depositExtra").classList.add("hidden");
  $("#photoPreview").classList.add("hidden");
  $("#photoPreview").removeAttribute("src");
}

function editExpense(id) {
  const r = state.ledger.find(x => x.id === id);
  if (!r) return;
  showTab("expenses");
  resetExpenseForm();
  $("#exId").value = r.id; $("#exDate").value = r.date; $("#exVendor").value = r.vendor; $("#exDesc").value = r.desc;
  $("#exCat").innerHTML = catOptions(r.cat); $("#exAmount").value = hasAmount(r) ? r.amount : "";
  $("#exStatus").value = r.status; $("#exDue").value = r.due; $("#exNote").value = r.note;
  $("#expenseFormTitle").textContent = `Fix expense #${r.id}`;
  $("#exSubmit").textContent = "Save changes";
  $("#exCancel").classList.remove("hidden");
  $("#exVendor").focus();
}

// Remember what category the owner used last time for this vendor (the harness's "category corrections" memory).
function rememberedCategory(vendor) {
  const n = normVendor(vendor);
  if (!n) return "";
  const hit = state.ledger.slice().sort((a, b) => b.id - a.id).find(r => normVendor(r.vendor) === n && r.cat);
  return hit ? hit.cat : "";
}

// ---------- CSV ----------
function parseCSV(text) {
  const rows = []; let row = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
  return rows.filter(r => r.some(c => c.trim())).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
}
function csvCell(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function readFile(input, cb) {
  const file = input.files[0];
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => { cb(fr.result); input.value = ""; };
  fr.readAsText(file);
}
const pick = (o, ...keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== "") return o[k]; return ""; };
const num = s => { const n = parseFloat(String(s).replace(/[$,]/g, "")); return isNaN(n) ? null : n; };

// ---------- events ----------
document.addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  const d = b.dataset;
  if (d.tab) return showTab(d.tab);
  if (d.goto) return showTab(d.goto);
  if (d.edit) return editExpense(Number(d.edit));
  if (d.ok) {
    const r = state.ledger.find(x => x.id === Number(d.ok));
    r.ok = true; r.note = ""; stamp(r); noteNext("confirmed an expense", `#${r.id} ${r.vendor || r.desc || ""} ${hasAmount(r) ? money(r.amount) : ""}`.trim()); save(); renderAll(); return toast(`#${r.id} confirmed`);
  }
  if (d.paid) {
    const r = state.ledger.find(x => x.id === Number(d.paid));
    r.status = "paid"; if (!r.date) r.date = todayISO(); stamp(r); noteNext("marked an expense paid", `#${r.id} ${r.vendor || r.desc || ""} ${hasAmount(r) ? money(r.amount) : ""}`.trim()); save(); renderAll(); return toast(`#${r.id} marked paid`);
  }
  if (d.del) {
    if (!confirm("Delete this expense?")) return;
    bury("ledger", state.ledger.find(x => x.id === Number(d.del)));
    noteNext("deleted an expense", "#" + d.del); state.ledger = state.ledger.filter(x => x.id !== Number(d.del)); save(); renderAll(); return;
  }
  if (d.delcash) {
    bury("cash", state.cash.find(c => c.date === d.delcash));
    noteNext("deleted a bank balance", d.delcash); state.cash = state.cash.filter(c => c.date !== d.delcash); save(); renderAll(); return;
  }
  if (d.delsale) {
    bury("sales", state.sales.find(s => s.week === d.delsale));
    noteNext("deleted a week of sales", d.delsale); state.sales = state.sales.filter(s => s.week !== d.delsale); save(); renderAll(); return;
  }
  if (d.delrec) {
    bury("recurring", state.recurring.find(r => r.id === Number(d.delrec)));
    noteNext("deleted a repeat bill", null); state.recurring = state.recurring.filter(r => r.id !== Number(d.delrec)); save(); renderAll(); return;
  }
  if (d.delmgmt) {
    bury("mgmt", state.mgmt.find(p => p.id === Number(d.delmgmt)));
    noteNext("removed someone from the manager payouts", null); state.mgmt = state.mgmt.filter(p => p.id !== Number(d.delmgmt)); save(); renderAll(); return;
  }
});

$("#clubForm").addEventListener("submit", e => {
  e.preventDefault();
  const s = state.settings;
  s.nextYearInv = Math.max(0, num($("#clubInv").value) ?? 0);
  s.mgmtPct = Math.min(100, Math.max(0, num($("#clubPct").value) ?? 0));
  noteNext("changed the year-end figures", null); save(); renderAll(); toast("Saved. The check was refigured");
});

$("#mgmtForm").addEventListener("submit", e => {
  e.preventDefault();
  const name = $("#mgmtName").value.trim();
  if (!name) return toast("Add a name first");
  state.mgmt.push(fresh({ id: state.nextMgmtId++, name, share: num($("#mgmtShare").value) ?? "" }));
  save(); e.target.reset(); renderAll(); toast(`${name} added`);
});

$("#affordForm").addEventListener("submit", e => {
  e.preventDefault();
  renderAfford(Number($("#affordAmount").value), $("#affordWhat").value.trim());
});

$("#exVendor").addEventListener("change", () => {
  if ($("#exCat").value) return;
  const c = rememberedCategory($("#exVendor").value);
  if (c) { $("#exCat").innerHTML = catOptions(c); toast(`Filed under ${c}, like last time`); }
});
$("#exDeposit").addEventListener("change", e => $("#depositExtra").classList.toggle("hidden", !e.target.checked));
$("#exPhoto").addEventListener("change", e => {
  const f = e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  $("#photoPreview").src = url; $("#photoPreview").classList.remove("hidden");
});
$("#exCancel").addEventListener("click", resetExpenseForm);

$("#expenseForm").addEventListener("submit", e => {
  e.preventDefault();
  const id = Number($("#exId").value) || null;
  const row = {
    date: $("#exDate").value, vendor: $("#exVendor").value.trim(), desc: $("#exDesc").value.trim(),
    cat: $("#exCat").value, amount: num($("#exAmount").value), status: $("#exStatus").value,
    due: $("#exStatus").value === "unpaid" ? $("#exDue").value : "", note: $("#exNote").value.trim(),
  };
  if (!row.vendor && !row.desc && row.amount === null) return toast("Add at least who was paid, what it was, or an amount");
  if (id) {
    const r = state.ledger.find(x => x.id === id);
    // An edit means a fresh look: the guard re-checks it and the owner confirms again.
    Object.assign(r, row, { ok: false });
    stamp(r);
    if (!flagsFor(r).length) r.ok = true;
    noteNext("changed an expense", `#${id} ${row.vendor || row.desc || ""} ${row.amount !== null ? money(row.amount) : ""}`.trim());
    toast(`#${id} updated`);
  } else {
    const r = fresh({ id: state.nextId++, ...row, ok: false, added: todayISO() });
    state.ledger.push(r);
    noteNext("added an expense", `${row.vendor || row.desc || "no name"} ${row.amount !== null ? money(row.amount) : "(no amount)"}`.trim());
    const flags = flagsFor(r);
    if (!flags.length) r.ok = true;
    if ($("#exDeposit").checked) {
      const bal = num($("#exBalance").value);
      const fu = fresh({
        id: state.nextId++, date: row.date, vendor: row.vendor, desc: `Remaining balance${row.desc ? " for " + row.desc : ""}`,
        cat: row.cat, amount: bal, status: "unpaid", due: $("#exBalanceDue").value,
        note: bal === null ? "Remaining balance not entered" : "", ok: false, added: todayISO(),
      });
      state.ledger.push(fu);
      if (!flagsFor(fu).length) fu.ok = true;
    }
    toast(flags.length ? `Saved #${r.id}, flagged for your OK: ${flags[0]}` : `Saved #${r.id}`);
  }
  save(); resetExpenseForm(); renderAll();
});
$("#filterStatus").addEventListener("change", renderExpenses);

$("#cashForm").addEventListener("submit", e => {
  e.preventDefault();
  const date = $("#cashDate").value;
  state.cash = state.cash.filter(c => c.date !== date).concat(stamp({ date, balance: num($("#cashBal").value) }));
  noteNext("added a bank balance", money(row.balance) + " on " + row.date); save(); e.target.reset(); $("#cashDate").value = todayISO(); renderAll(); toast("Balance saved");
});
$("#salesForm").addEventListener("submit", e => {
  e.preventDefault();
  const week = $("#salesDate").value;
  state.sales = state.sales.filter(s => s.week !== week).concat(stamp({ week, net: num($("#salesAmt").value) }));
  noteNext("added a week of sales", null); save(); e.target.reset(); renderAll(); toast("Sales saved");
});
$("#salesCsv").addEventListener("change", e => readFile(e.target, text => {
  let n = 0;
  parseCSV(text).forEach(r => {
    const week = pick(r, "week_ending", "week", "date");
    let net = num(pick(r, "net_sales", "net", "sales", "total"));
    if (net === null && pick(r, "gross_sales")) net = (num(r.gross_sales) || 0) - (num(r.refunds) || 0);
    if (!parseISO(week) || net === null) return;
    state.sales = state.sales.filter(s => s.week !== week).concat(stamp({ week, net })); n++;
  });
  noteNext("imported sales from a spreadsheet", n + " week" + (n === 1 ? "" : "s")); save(); renderAll(); toast(`Imported ${n} week${n === 1 ? "" : "s"} of sales`);
}));
$("#recForm").addEventListener("submit", e => {
  e.preventDefault();
  state.recurring.push(fresh({
    id: state.nextRecId++, name: $("#recName").value.trim(), cat: $("#recCat").value, amount: num($("#recAmt").value),
    due: $("#recDue").value, freq: $("#recFreq").value, notes: $("#recNotes").value.trim(),
  }));
  noteNext("added a repeat bill", null); save(); e.target.reset(); renderAll(); toast("Bill added");
});

$("#updateText").addEventListener("input", e => { e.target.dataset.touched = "1"; countWords(); });
$("#regenUpdate").addEventListener("click", () => { renderUpdate(true); toast("Rebuilt from the latest numbers"); });
$("#copyUpdate").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#updateText").value); toast("Copied. Paste it into a text when you're ready"); }
  catch { $("#updateText").select(); toast("Press Cmd+C to copy"); }
});

$("#priceForm").addEventListener("input", renderPricing);

$("#settingsForm").addEventListener("submit", e => {
  e.preventDefault();
  const s = state.settings;
  s.name = $("#setName").value.trim() || "My Business"; s.type = $("#setType").value; s.goal = $("#setGoal").value.trim();
  s.reserve = num($("#setReserve").value) ?? 0; s.horizon = Math.max(7, num($("#setHorizon").value) || 90);
  s.caution = Math.min(100, Math.max(0, num($("#setCaution").value) ?? 75)); s.big = num($("#setBig").value) ?? 1000;
  s.categories = $("#setCats").value.split(",").map(c => c.trim()).filter(Boolean);
  if (!s.categories.length) s.categories = DEFAULT_CATS.slice();
  noteNext("changed the settings", null); save(); renderAll(); toast("Settings saved");
});

$("#exportJson").addEventListener("click", async () => {
  await save();
  download(`silent-partner-backup-${todayISO()}.json`,
    JSON.stringify({ app: "silent-partner", v: 2, savedAt: new Date().toISOString(), books: state }, null, 2),
    "application/json");
  SPCloud.note("downloaded a backup", null);
  toast("Backup downloaded");
});
$("#importJson").addEventListener("change", e => readFile(e.target, text => {
  let obj;
  try { obj = JSON.parse(text); } catch { return toast("That file isn't a Silent Partner backup"); }
  const books = obj && obj.books ? obj.books : obj;
  if (!books || !books.settings) return toast("That file isn't a Silent Partner backup");
  if (!confirm("Replace everything in these books with the contents of that file? Everyone who uses these books will see the restored version.")) return;
  state = normalizeState(books);
  noteNext("restored the books from a backup file", obj.savedAt ? "saved " + obj.savedAt : null);
  save(); renderAll();
  toast("Books restored");
}));

$("#pwForm").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#pwErr");
  err.textContent = "";
  const nw = $("#pwNew").value;
  if (nw.length < 8) return (err.textContent = "Use at least 8 characters. A short phrase works well.");
  if (nw !== $("#pwNew2").value) return (err.textContent = "The new passwords don't match.");
  try {
    await SPAuth.setPassword(nw);
    e.target.reset();
    SPCloud.note("changed their own password", null);
    toast("Your password is changed. It only affects your own account.");
  } catch (ex) { err.textContent = SPAuth.explain(ex); }
});

$("#exportCsv").addEventListener("click", () => {
  const head = ["id", "date", "vendor", "description", "category", "amount", "status", "due_date", "needs_review"];
  const lines = [head.join(",")].concat(state.ledger.map(r =>
    [r.id, r.date, r.vendor, r.desc, r.cat, hasAmount(r) ? r.amount : "", r.status, r.due, flagsFor(r).join("; ")].map(csvCell).join(",")));
  download(`expenses-${todayISO()}.csv`, lines.join("\n"), "text/csv");
});
$("#ledgerCsv").addEventListener("change", e => readFile(e.target, text => {
  let n = 0;
  parseCSV(text).forEach(r => {
    const row = fresh({
      id: state.nextId++, date: parseISO(pick(r, "date")) ? r.date : "", vendor: pick(r, "vendor", "payee", "who"),
      desc: pick(r, "description", "desc", "memo", "what"), cat: pick(r, "category", "cat"),
      amount: num(pick(r, "amount", "total")), status: (pick(r, "status").toLowerCase().match(/^(paid|unpaid)$/) || [""])[0],
      due: pick(r, "due_date", "due"), note: pick(r, "needs_review", "note"), ok: false, added: todayISO(),
    });
    state.ledger.push(row);
    if (!flagsFor(row).length) row.ok = true;
    n++;
  });
  noteNext("imported expenses from a spreadsheet", n + " row" + (n === 1 ? "" : "s")); save(); renderAll(); toast(`Imported ${n} expense${n === 1 ? "" : "s"}. Check "Needs your OK"`);
}));

function startFresh() {
  if (!confirm("Erase everything in these books and start over? (Download a backup first if you want to keep anything.)")) return;
  noteNext("erased the books and started over", null); state = freshState(); save(); resetExpenseForm(); renderAll(); showTab("settings");
  toast("Fill in your business, then add your bank balance and bills");
}
$("#startFresh").addEventListener("click", startFresh);

// ---------- lock screen & boot ----------
function enterApp() {
  document.body.classList.remove("locked");
  $("#cashDate").value = todayISO();
  resetExpenseForm();
  renderAll();
  showTab("home");
  startIdleTimer();
}

function startIdleTimer() {
  let t;
  const reset = () => { clearTimeout(t); t = setTimeout(lockNow, IDLE_LOCK_MS); };
  ["click", "keydown", "mousemove", "touchstart", "scroll"].forEach(ev => document.addEventListener(ev, reset, { passive: true }));
  reset();
}

document.addEventListener("change", e => {
  const name = e.target && e.target.dataset && e.target.dataset.tabtoggle;
  if (!name || !state) return;
  state.settings.tabs = Object.assign({}, DEFAULT_TABS, state.settings.tabs || {});
  state.settings.tabs[name] = e.target.checked;
  noteNext(e.target.checked ? "turned a page back on" : "hid a page", name);
  save(); applyTabs();
});

$("#lockBtn").addEventListener("click", lockNow);

/* ---------------------------------------------------------------------------
 * Getting in: the link word, then an account.
 * ------------------------------------------------------------------------- */
const $$ = sel => document.querySelector(sel);
const SCREENS = ["gateForm", "signinForm", "signupForm", "forgotForm", "codeForm", "newPwForm"];
function screen(id) {
  SCREENS.forEach(x => { const el = $$("#" + x); if (el) el.classList.toggle("hidden", x !== id); });
  const first = $$("#" + id + " input");
  if (first) setTimeout(() => first.focus(), 30);
}

// The door word. Checked here in the browser on purpose: it keeps the sign-up page from being
// the first thing a stranger sees, and it is not pretending to be more than that. The books
// are guarded by the account and by the database, not by this.
$$("#gateForm").addEventListener("submit", e => {
  e.preventDefault();
  if (SPAuth.tryGate($$("#gateWord").value)) { $$("#gateErr").textContent = ""; screen("signinForm"); }
  else $$("#gateErr").textContent = "That isn't the word. Check the message your link came in.";
});

$$("#toSignup").addEventListener("click", () => screen("signupForm"));
$$("#toSignin").addEventListener("click", () => screen("signinForm"));
$$("#toForgot").addEventListener("click", () => screen("forgotForm"));
$$("#backToSignin").addEventListener("click", () => screen("signinForm"));

$$("#signinForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true; btn.textContent = "Signing in\u2026";
  $$("#siErr").textContent = "";
  try {
    await SPAuth.signIn($$("#siEmail").value, $$("#siPw").value);
    await openBooks();
  } catch (err) {
    $$("#siErr").textContent = SPAuth.explain(err);
    btn.disabled = false; btn.textContent = "Sign in";
  }
});

$$("#signupForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  const pw = $$("#suPw").value, pw2 = $$("#suPw2").value;
  $$("#suErr").textContent = "";
  if (pw !== pw2) { $$("#suErr").textContent = "Those two passwords don't match."; return; }
  if (pw.length < 8) { $$("#suErr").textContent = "Passwords need to be at least 8 characters. A short phrase works well."; return; }
  btn.disabled = true; btn.textContent = "Creating\u2026";
  try {
    const { needsConfirm } = await SPAuth.signUp($$("#suEmail").value, pw);
    if (needsConfirm) { askForCode($$("#suEmail").value, "signup"); return; }
    await openBooks();
  } catch (err) {
    $$("#suErr").textContent = SPAuth.explain(err);
  } finally { btn.disabled = false; btn.textContent = "Create account"; }
});

$$("#forgotForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true; btn.textContent = "Sending\u2026";
  $$("#fpErr").textContent = "";
  try {
    await SPAuth.sendReset($$("#fpEmail").value);
    askForCode($$("#fpEmail").value, "recovery");
  } catch (err) { $$("#fpErr").textContent = SPAuth.explain(err); }
  finally { btn.disabled = false; btn.textContent = "Email me a code"; }
});

/* ---------------------------------------------------------------------------
 * The code from the email.
 *
 * Both jobs that need one -- proving a new email address is yours, and proving it is still
 * yours when the password has gone -- are the same screen, because to the person typing it
 * they are the same act. What differs is only what happens after it checks out.
 * ------------------------------------------------------------------------- */
let codeFor = { email: "", kind: "signup" };

function askForCode(email, kind) {
  codeFor = { email, kind };
  $$("#codeWhere").textContent = email;
  $$("#codeInput").value = "";
  $$("#codeErr").textContent = "";
  $$("#codeOk").classList.add("hidden");
  screen("codeForm");
}

$$("#codeForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  const code = SPAuth.cleanCode($$("#codeInput").value);
  $$("#codeErr").textContent = "";
  $$("#codeOk").classList.add("hidden");
  // Say the obvious thing before spending a round trip on it.
  if (code.length < 4) { $$("#codeErr").textContent = "That looks too short. The code in the email is the whole row of digits."; return; }

  btn.disabled = true; btn.textContent = "Checking\u2026";
  try {
    await SPAuth.verifyCode(codeFor.email, code, codeFor.kind);
    if (codeFor.kind === "recovery") { screen("newPwForm"); return; }
    await openBooks();
  } catch (err) {
    $$("#codeErr").textContent = SPAuth.explain(err);
  } finally { btn.disabled = false; btn.textContent = "Confirm"; }
});

// Typing in the box clears a stale complaint, and a pasted code with spaces in it is fine.
$$("#codeInput").addEventListener("input", e => {
  const cleaned = SPAuth.cleanCode(e.target.value);
  if (e.target.value !== cleaned) e.target.value = cleaned;
  $$("#codeErr").textContent = "";
});

$$("#codeResend").addEventListener("click", async () => {
  const btn = $$("#codeResend");
  btn.disabled = true; btn.textContent = "Sending\u2026";
  $$("#codeErr").textContent = "";
  try {
    await SPAuth.resendCode(codeFor.email, codeFor.kind);
    $$("#codeOk").textContent = "Sent. The newest code is the one that works \u2014 any earlier one has stopped.";
    $$("#codeOk").classList.remove("hidden");
  } catch (err) { $$("#codeErr").textContent = SPAuth.explain(err); }
  finally { btn.disabled = false; btn.textContent = "Send me another code"; }
});

$$("#codeBack").addEventListener("click", () => screen("signinForm"));

$$("#newPwForm").addEventListener("submit", async e => {
  e.preventDefault();
  const a = $$("#npPw").value, b = $$("#npPw2").value;
  $$("#npErr").textContent = "";
  if (a !== b) { $$("#npErr").textContent = "Those two don\u2019t match."; return; }
  if (a.length < 8) { $$("#npErr").textContent = "At least 8 characters, please."; return; }
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true; btn.textContent = "Saving\u2026";
  try {
    await SPAuth.setPassword(a);
    await openBooks();   // the code already signed them in
  } catch (err) {
    $$("#npErr").textContent = SPAuth.explain(err);
    btn.disabled = false; btn.textContent = "Save new password";
  }
});

/* ---------------------------------------------------------------------------
 * Opening the books once somebody is signed in.
 * ------------------------------------------------------------------------- */
async function openBooks() {
  const user = await SPAuth.currentUser();
  if (!user) { screen("signinForm"); return; }
  session = { user };

  await SPCloud.join((window.SP_CONFIG && SP_CONFIG.shopName) || "My Business");
  const doc = await SPCloud.load();

  state = doc && doc.settings ? normalizeState(doc) : freshState();
  if (!doc || !doc.settings) await SPCloud.save(JSON.parse(JSON.stringify(state)));

  await SPCloud.note("signed in", null);

  const badge = $$("#whoBadge");
  if (badge) { badge.textContent = user.email; badge.classList.remove("hidden"); }

  enterApp();

  // Somebody else saving, while this page is open.
  SPCloud.watch((remoteDoc, who) => {
    const merged = window.SPMerge ? SPMerge.merge(state, remoteDoc) : remoteDoc;
    state = normalizeState(merged);
    renderAll();
    toast((who || "Someone else") + " just made a change \u2014 you're looking at the latest.");
  });
}

/* ---------------------------------------------------------------------------
 * The History tab.
 * ------------------------------------------------------------------------- */
let histCache = [];

async function renderHistory() {
  try { histCache = await SPCloud.history(500); }
  catch { histCache = []; }

  const who = $$("#histWho");
  if (who) {
    const emails = [...new Set(histCache.map(r => r.email))].sort();
    const chosen = who.value;
    who.innerHTML = '<option value="">everyone</option>' +
      emails.map(e => `<option${e === chosen ? " selected" : ""}>${esc(e)}</option>`).join("");
  }

  const onlyChanges = $$("#histChangesOnly") && $$("#histChangesOnly").checked;
  const pick = who ? who.value : "";
  const rows = histCache.filter(r =>
    (!pick || r.email === pick) &&
    (!onlyChanges || !/^signed (in|out)$/.test(r.action)));

  $$("#histRows").innerHTML = rows.map(r => `<tr>
      <td>${esc(niceLong(r.at))}</td>
      <td>${esc(r.email)}</td>
      <td>${esc(r.action)}</td>
      <td class="muted">${esc(r.detail || "")}</td>
    </tr>`).join("");
  $$("#histEmpty").classList.toggle("hidden", rows.length > 0);
}

function niceLong(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || "");
  return d.toLocaleString(undefined,
    { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

["histWho", "histChangesOnly"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", renderHistory);
});
if ($$("#histRefresh")) $$("#histRefresh").addEventListener("click", renderHistory);
if ($$("#histCsv")) $$("#histCsv").addEventListener("click", () => {
  const head = ["When", "Who", "What they did", "Detail"];
  const body = histCache.map(r => [niceLong(r.at), r.email, r.action, r.detail || ""]);
  const csv = [head, ...body].map(row => row.map(csvCell).join(",")).join("\r\n");
  download(`silent-partner-history-${todayISO()}.csv`, csv, "text/csv");
});

/* ---------------------------------------------------------------------------
 * Boot.
 * ------------------------------------------------------------------------- */
(function boot() {
  if (!window.supabase || !window.SP_CONFIG || String(SP_CONFIG.supabaseUrl).startsWith("PASTE")) {
    $$("#noCrypto").classList.remove("hidden");
    $$("#noCrypto").textContent = "This copy of the site hasn't been connected to its database yet. See docs/SETUP.md.";
    return;
  }

  SPAuth.currentUser()
    .then(user => {
      if (user) return openBooks();
      screen(SPAuth.gatePassed() ? "signinForm" : "gateForm");
    })
    .catch(() => screen("gateForm"));
})();
