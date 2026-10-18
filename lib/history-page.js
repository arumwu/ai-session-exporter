'use strict';
// Opt-in paged reading. Existing export callers retain their original limits.
const MAX_SCAN_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const fail = code => Object.assign(Error(code), { code, status: 409 });
function historyPage(options) {
  if (!options.page) return null;
  // Internal handoff reads scan once and retain a bounded complete transcript.
  // Normal UI pages and export callers keep their existing limits.
  const complete = options.handoff === true;
  const before = options.before ?? null;
  if (complete && before !== null) throw fail('input');
  if (before !== null && (!Number.isSafeInteger(before) || before < 1 || !/^[a-f0-9]{64}$/.test(options.pageSignature || ''))) throw fail('input');
  let count = 0, bytes = 0, start = 0;
  const rows = [], deadline = Date.now() + 60000;
  return {
    rows,
    check(seen) { if (Date.now() > deadline || seen.size > 1000000) throw fail('limit'); },
    add(row) {
      const index = count++;
      if (before !== null && index >= before) return;
      const size = Buffer.byteLength(row.text);
      if (size > MAX_PAGE_BYTES) throw fail('limit');
      rows.push(row); bytes += size;
      if (complete) {
        if (rows.length > 100000 || bytes > 32 * 1024 * 1024) throw fail('limit');
        return;
      }
      while (rows.length > 120 || bytes > MAX_PAGE_BYTES) { bytes -= Buffer.byteLength(rows.shift().text); start++; }
    },
    finish(signature) {
      if (options.pageSignature && options.pageSignature !== signature) throw fail('stale');
      return { totalRows: count, pageStart: start, hasMore: start > 0, nextBefore: start > 0 ? start : null, pageSignature: signature };
    }
  };
}
module.exports = { historyPage, MAX_SCAN_BYTES };
