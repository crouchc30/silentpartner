/* Silent Partner: merging two sets of books.
 *
 * Sync means the store manager can type on the shop iPad while someone else types on a laptop.
 * Whoever saves second must not erase the other one's work, so "last save wins" is not good
 * enough: it would silently throw away a morning of entries.
 *
 * So the books are merged row by row instead of file by file:
 *   - every row carries a uid, so the same row is recognised on both sides
 *   - every row carries "touched", the moment it was last edited, so a genuine edit conflict
 *     can be settled by taking the newer one
 *   - deleting a row leaves a tombstone, so a delete on one device isn't undone by the other
 *     device still having the row
 *
 * Rows written before sync existed have no uid. They get a key built from what's in them, so the
 * same row arriving from two devices still lands on top of itself rather than duplicating.
 *
 * This file is pure: no browser, no network, no state. tools/sync-selftest.mjs runs it in node.
 */
(function (root) {
  "use strict";

  function norm(v) { return String(v == null ? "" : v).trim().toLowerCase(); }
  function amt(v) { return v === null || v === undefined || v === "" ? "" : String(Number(v)); }

  // A row's identity. uid when it has one; otherwise its contents, so the same legacy row coming
  // from two devices collapses into one instead of doubling up.
  const KEYS = {
    ledger: r => r.uid || `l:${norm(r.date)}|${norm(r.vendor)}|${norm(r.desc)}|${amt(r.amount)}|${r.id}`,
    cash: r => `c:${norm(r.date)}`,       // the app already keeps one balance per date
    sales: r => `s:${norm(r.week)}`,      // and one sales figure per week
    recurring: r => r.uid || `r:${norm(r.name)}|${amt(r.amount)}|${norm(r.freq)}|${norm(r.due)}`,
    mgmt: r => r.uid || `m:${norm(r.name)}|${amt(r.share)}`,
  };
  const COLLECTIONS = Object.keys(KEYS);

  function keyOf(collection, row) { return KEYS[collection](row); }

  // When a row was last touched. Rows saved before this field existed fall back to the moment
  // their whole set of books was last saved, which is the best we know about them.
  function touchedAt(row, fallback) { return row && row.touched ? row.touched : fallback; }

  function laterOf(a, b) { return (a || "") >= (b || "") ? a : b; }

  /* Merge two sets of books.
   *
   *   mine   = { state, savedAt }   this device
   *   theirs = { state, savedAt }   what came back from the repo
   *
   * Returns { state, changed, added, updated, removed } where the counts describe what arrived
   * from the other side, so the page can tell the owner what just showed up.
   */
  function mergeBooks(mine, theirs) {
    const a = { state: mine.state, at: mine.savedAt || "" };
    const b = { state: theirs.state, at: theirs.savedAt || "" };

    // Settings aren't row-shaped, so they're taken whole from whichever side was saved last.
    const newer = b.at > a.at ? b : a;
    const older = newer === a ? b : a;
    const out = JSON.parse(JSON.stringify(newer.state));

    // Tombstones from both sides, keeping the later time if a row was deleted on both.
    const graves = Object.assign({}, older.state.deleted || {});
    const mineGraves = newer.state.deleted || {};
    for (const k of Object.keys(mineGraves)) graves[k] = laterOf(graves[k], mineGraves[k]);
    out.deleted = graves;

    const report = { added: 0, updated: 0, removed: 0 };

    for (const name of COLLECTIONS) {
      const rowsA = Array.isArray(a.state[name]) ? a.state[name] : [];
      const rowsB = Array.isArray(b.state[name]) ? b.state[name] : [];
      const merged = new Map();

      const take = (rows, side, isRemote) => {
        for (const row of rows) {
          const k = keyOf(name, row);
          const when = touchedAt(row, side.at);
          const seen = merged.get(k);
          if (!seen) { merged.set(k, { row, when, fromRemote: isRemote, alsoLocal: !isRemote }); continue; }
          seen.alsoLocal = seen.alsoLocal || !isRemote;
          if (when > seen.when) {                       // a genuine edit conflict: newer wins
            const wasElsewhere = seen.fromRemote !== isRemote;
            merged.set(k, { row, when, fromRemote: isRemote, alsoLocal: seen.alsoLocal });
            if (wasElsewhere && isRemote) report.updated++;
          }
        }
      };
      take(rowsA, a, false);
      take(rowsB, b, true);

      const kept = [];
      for (const [k, entry] of merged) {
        // A tombstone only wins if nobody edited the row after it was deleted. That way deleting
        // on the iPad sticks, but re-entering it afterwards on the laptop also sticks.
        const grave = graves[k];
        if (grave && grave >= entry.when) { if (entry.alsoLocal) report.removed++; continue; }
        if (entry.fromRemote && !entry.alsoLocal) report.added++;
        kept.push(entry.row);
      }
      out[name] = kept;
    }

    // Ids are handed out per device, so both sides may have reached #7. Push the counters past
    // everything that survived, or the next row added here would overwrite one of theirs.
    out.nextId = nextAbove(out.ledger, a.state.nextId, b.state.nextId);
    out.nextRecId = nextAbove(out.recurring, a.state.nextRecId, b.state.nextRecId);
    out.nextMgmtId = nextAbove(out.mgmt, a.state.nextMgmtId, b.state.nextMgmtId);

    out.deleted = pruneGraves(out.deleted);
    report.changed = report.added + report.updated + report.removed > 0;
    return Object.assign({ state: out }, report);
  }

  function nextAbove(rows, x, y) {
    let top = Math.max(Number(x) || 1, Number(y) || 1);
    for (const r of rows || []) top = Math.max(top, (Number(r.id) || 0) + 1);
    return top;
  }

  // Tombstones are tiny, but they'd grow forever. A row deleted over a year ago is not coming
  // back from another device, so the marker can go.
  function pruneGraves(graves) {
    const cutoff = new Date(Date.now() - 365 * 86400000).toISOString();
    const out = {};
    for (const k of Object.keys(graves || {})) if (graves[k] >= cutoff) out[k] = graves[k];
    return out;
  }

  const api = { mergeBooks, keyOf, COLLECTIONS, pruneGraves };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SPMerge = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
