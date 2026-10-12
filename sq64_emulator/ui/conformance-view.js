export function conformanceView({request, save}) {
  const $ = id => document.getElementById(id);
  let state, busy = false, rendered;
  function render(next) {
    state = next;
    const report = state?.report?.conformance;
    $('validate-image').disabled = busy || !state?.loaded || !!state?.terminated || !!state?.locked;
    $('validate-image').textContent = busy ? 'Validating…' : 'Validate Image';
    $('validation-save').disabled = busy || !report;
    const key = JSON.stringify(report);
    if (key === rendered) return;
    rendered = key;
    $('validation-results').hidden = !report;
    $('validation-summary').textContent = report
      ? `${state?.terminated ? 'UNSAFE' : report.status.toUpperCase()} · ${report.counts.pass} passed · ${report.counts.fail} failed · ${report.counts['not-run']} not run`
      : state?.loaded ? 'Ready to validate the loaded file.' : 'Load firmware to validate its image.';
    $('validation-message').textContent = '';
    if (!report) return;
    $('validation-source').textContent = `Spec ${report.specVersion} · image profile · revision ${report.specSource.revision.slice(0, 12)}`;
    $('validation-hash').textContent = `Loaded file SHA-256: ${report.imageSha256}`;
    $('validation-format').hidden = report.results.find(r => r.id === 'PKG-001')?.status === 'pass';
    $('validation-rows').replaceChildren(...report.results.map(row => {
      const tr = document.createElement('tr'); tr.dataset.status = row.status;
      const unsafe = row.severity === 'critical' && row.unsafeWhen === 'pass' && row.status === 'pass';
      tr.dataset.unsafe = String(unsafe);
      for (const value of [row.id, unsafe ? 'PASS · UNSAFE' : row.status.toUpperCase(), row.detail]) {
        const cell = document.createElement('td'); cell.textContent = value; tr.append(cell);
      }
      return tr;
    }));
  }
  $('validate-image').addEventListener('click', async () => {
    busy = true; render(state); $('validation-message').textContent = '';
    try { await request('validate'); }
    catch (error) { $('validation-message').textContent = error.message; }
    finally { busy = false; render(state); }
  });
  $('validation-save').addEventListener('click', () => {
    if (state?.report?.conformance) save(state.report.conformance, 'sq64-conformance.json');
  });
  render();
  return {render};
}
