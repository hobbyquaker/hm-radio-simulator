/**
 * The filter bar over the test results (task 37): chips for the result, "variants differ", the daemon, the kind, the
 * regression proof and the result on one ref, plus a text search over name, file and description. Within a group the
 * chips are alternatives (OR), across groups all must hold (AND). The state lives in the URL hash
 * (`#f=fail,rfd&q=lgw`), so a filtered view can be linked.
 *
 * Progressive enhancement: the bar is rendered `hidden` and only shown by its script; without JavaScript every row
 * stays visible. The script is plain DOM: it reads the rows' data-* attributes (scripts/report.mjs sets them) and
 * toggles `hidden` on rows and on file sections without a visible row. The table of differing rows (#differing) is not
 * filtered.
 */

const esc = (text) =>
    String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

/**
 * The chips: [group, token, label, test(attrs)].
 * @param {string[]} refs the refs in column order (data-r0, data-r1, ...)
 */
export function chipDefinitions(refs) {
    const chips = [];
    for (const r of ['fail', 'todo', 'pass', 'skip']) {
        chips.push([
            'result',
            r,
            r === 'todo' ? 'todo (known broken)' : r,
            (a) => a['data-result'].split(' ').includes(r),
        ]);
    }
    chips.push(['differs', 'differs', 'variants differ', (a) => a['data-differs'] === 'yes']);
    for (const d of ['rfd', 'hs485d']) {
        chips.push(['daemon', d, d, (a) => a['data-daemon'] === d]);
    }
    for (const [k, label] of [
        ['regression', 'regression'],
        ['known-bug', 'known bug'],
        ['behaviour', 'behaviour'],
        ['fuzz', 'fuzz'],
    ]) {
        chips.push(['kind', k, label, (a) => a['data-kind'] === k]);
    }
    for (const [p, label] of [
        ['proven', 'proven'],
        ['not-proven', 'not proven'],
    ]) {
        chips.push(['proof', p, label, (a) => a['data-proof'] === p]);
    }
    refs.forEach((ref, i) => {
        for (const r of ['fail', 'todo']) {
            chips.push([
                `ref${i}`,
                `r${i}-${r}`,
                `${r === 'fail' ? 'fails' : 'todo'} on ${ref}`,
                (a) => a[`data-r${i}`] === r,
            ]);
        }
    });
    return chips;
}

/**
 * The bar, with each chip's count over the rows (a chip nobody would match is left out).
 * @param {object[]} rows the rows' attributes, one per test (the file tables, not the differing-rows table)
 * @param {string[]} refs
 */
export function renderFilterBar(rows, refs) {
    const groups = new Map();
    for (const [group, token, label, test] of chipDefinitions(refs)) {
        const count = rows.filter(test).length;
        if (!count) {
            continue;
        }
        if (!groups.has(group)) {
            groups.set(group, []);
        }
        groups
            .get(group)
            .push(
                `<label class="fchip"><input type="checkbox" value="${esc(token)}" data-group="${esc(group)}"> ${esc(label)} <span class="fcount">${count}</span></label>`,
            );
    }
    const names = {result: 'result', differs: '', daemon: 'daemon', kind: 'kind', proof: 'proof'};
    const html = [...groups.entries()]
        .map(
            ([group, chips]) =>
                `<fieldset class="fgroup"><legend>${esc(names[group] ?? (group.startsWith('ref') ? refs[Number(group.slice(3))] : group))}</legend>${chips.join('')}</fieldset>`,
        )
        .join('');
    return `<form class="filter" id="filter" hidden role="search" aria-label="filter the tests" onsubmit="return false"><div class="fgroups">${html}</div><div class="fsearch"><label>search <input type="search" id="fq" placeholder="name, file or description" autocomplete="off"></label> <button type="button" id="freset">reset</button> <span id="fshown" aria-live="polite">${rows.length} of ${rows.length} tests shown</span></div></form>`;
}

/** The script (inline, plain DOM). */
export const FILTER_SCRIPT = `
(function () {
  var form = document.getElementById('filter');
  var tables = document.getElementById('test-tables');
  if (!form || !tables) return;
  form.hidden = false;
  var boxes = Array.prototype.slice.call(form.querySelectorAll('input[type=checkbox]'));
  var q = document.getElementById('fq');
  var shown = document.getElementById('fshown');
  var rows = Array.prototype.slice.call(tables.querySelectorAll('tr[data-row]'));
  function matches(row, token, group) {
    var d = row.dataset;
    if (group === 'result') return (' ' + d.result + ' ').indexOf(' ' + token + ' ') >= 0;
    if (group === 'differs') return d.differs === 'yes';
    if (group === 'daemon') return d.daemon === token;
    if (group === 'kind') return d.kind === token;
    if (group === 'proof') return d.proof === token;
    var m = /^r(\\d+)-(\\w+)$/.exec(token);
    return m ? d['r' + m[1]] === m[2] : true;
  }
  function apply(fromHash) {
    var groups = {};
    boxes.forEach(function (b) {
      if (b.checked) (groups[b.dataset.group] = groups[b.dataset.group] || []).push(b.value);
    });
    var text = q.value.trim().toLowerCase();
    var visible = 0;
    rows.forEach(function (row) {
      var ok = Object.keys(groups).every(function (g) {
        return groups[g].some(function (t) { return matches(row, t, g); });
      });
      if (ok && text) ok = row.dataset.text.indexOf(text) >= 0;
      row.hidden = !ok;
      if (ok) visible++;
    });
    Array.prototype.forEach.call(tables.querySelectorAll('section.test-file'), function (sec) {
      sec.hidden = !sec.querySelector('tr[data-row]:not([hidden])');
    });
    shown.textContent = visible + ' of ' + rows.length + ' tests shown';
    if (!fromHash) {
      var tokens = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
      var hash = (tokens.length ? 'f=' + tokens.join(',') : '') + (text ? (tokens.length ? '&' : '') + 'q=' + encodeURIComponent(text) : '');
      history.replaceState(null, '', hash ? '#' + hash : location.pathname + location.search);
    }
  }
  function fromHash() {
    var h = location.hash.slice(1);
    if (!/(^|&)(f|q)=/.test(h)) return false;
    var params = {};
    h.split('&').forEach(function (p) { var i = p.indexOf('='); if (i > 0) params[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1)); });
    var tokens = (params.f || '').split(',');
    boxes.forEach(function (b) { b.checked = tokens.indexOf(b.value) >= 0; });
    q.value = params.q || '';
    return true;
  }
  boxes.forEach(function (b) { b.addEventListener('change', function () { apply(false); }); });
  q.addEventListener('input', function () { apply(false); });
  document.getElementById('freset').addEventListener('click', function () {
    boxes.forEach(function (b) { b.checked = false; });
    q.value = '';
    apply(false);
  });
  window.addEventListener('hashchange', function () { if (fromHash()) apply(true); });
  if (fromHash()) apply(true);
})();
`;

export const FILTER_CSS = `
.filter { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: .5rem .75rem; margin: .5rem 0 1rem;
  position: sticky; top: 0; z-index: 2; }
.fgroups { display: flex; flex-wrap: wrap; gap: .25rem 1rem; }
.fgroup { border: 0; margin: 0; padding: 0; display: flex; flex-wrap: wrap; align-items: center; gap: .3rem; }
.fgroup legend { float: left; margin-right: .3rem; font-size: .72rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.fchip { display: inline-flex; align-items: center; gap: .25rem; border: 1px solid var(--line); border-radius: 999px;
  padding: .05rem .55rem; font-size: .82rem; cursor: pointer; background: var(--bg); }
.fchip:has(input:checked) { border-color: var(--link); color: var(--link); }
.fchip input { margin: 0; accent-color: var(--link); } .fcount { color: var(--muted); font-variant-numeric: tabular-nums; font-size: .75rem; }
.fsearch { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-top: .4rem; font-size: .85rem; }
.fsearch input[type=search] { font: inherit; padding: .15rem .4rem; border: 1px solid var(--line); border-radius: 6px;
  background: var(--bg); color: var(--fg); min-width: 14rem; }
.fsearch button { font: inherit; padding: .1rem .6rem; border: 1px solid var(--line); border-radius: 6px; background: var(--bg);
  color: var(--fg); cursor: pointer; }
#fshown { color: var(--muted); margin-left: auto; }
@media (max-width: 760px) { .filter { position: static; } .fsearch input[type=search] { min-width: 0; width: 100%; } }
`;
