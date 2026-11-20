import {
  buildManifestPreview,
  compareSnapshots,
  makeCut,
  makeSnapshot,
  runSelfChecks,
  sha256Hex,
} from '/core.js';

const $ = (selector) => document.querySelector(selector);
const MANIFEST_DOWNLOAD = $('#download-manifest');
const SNAPSHOT_KEY = 'cup-showcase-fork-cut-review-v1';
const MAX_SNAPSHOTS = 100;
const MAX_CUTS = 200;
const HEX_256 = /^[a-f0-9]{64}$/;

function setMessage(element, text, kind = '') {
  element.textContent = text;
  element.classList.remove('is-error', 'is-success');
  if (kind) element.classList.add(`is-${kind}`);
}

function appendText(parent, tag, text, className = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let latestManifest = null;
const manifestForm = $('#manifest-form');
const manifestFiles = $('#manifest-files');
const manifestOutput = $('#manifest-output');
const manifestState = $('#manifest-state');
const manifestMessage = $('#manifest-message');

function invalidateManifestPreview() {
  if (!latestManifest) return;
  latestManifest = null;
  MANIFEST_DOWNLOAD.disabled = true;
  manifestState.textContent = 'STALE';
  manifestOutput.textContent = 'Inputs changed since the last preview. Hash the current selection again before downloading.';
  setMessage(manifestMessage, 'A file or preview detail changed. Rebuild the manifest preview before exporting it.');
}

manifestForm.querySelectorAll('input:not([type="file"]), textarea').forEach((field) => field.addEventListener('input', invalidateManifestPreview));
manifestFiles.addEventListener('change', invalidateManifestPreview);

manifestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  latestManifest = null;
  MANIFEST_DOWNLOAD.disabled = true;
  manifestState.textContent = 'HASHING';
  setMessage(manifestMessage, 'Reading and hashing selected bytes in this browser. Nothing is uploaded.');
  try {
    const preview = await buildManifestPreview(manifestFiles.files, {
      crate: $('#manifest-crate').value,
      version: $('#manifest-version').value,
      intended_use: $('#intended-use').value,
      tested: $('#manifest-tested').value,
      uncertain: $('#manifest-uncertain').value,
      challenge: $('#manifest-challenge').value,
    });
    latestManifest = preview;
    const display = {
      manifest: preview.manifest,
      manifest_sha256: preview.manifestSha256,
      hash_method: 'SHA-256 over each selected file’s raw bytes; SHA-256 of UTF-8 canonical JSON for this preview (object keys sorted, arrays retained). Showcase convention only.',
      status: 'PROPOSED / NOT SEALED',
    };
    manifestOutput.textContent = JSON.stringify(display, null, 2);
    manifestState.textContent = 'PREVIEW READY';
    MANIFEST_DOWNLOAD.disabled = false;
    setMessage(manifestMessage, `${preview.manifest.files.length} file${preview.manifest.files.length === 1 ? '' : 's'} hashed locally. This is not a seal.`, 'success');
  } catch (error) {
    manifestState.textContent = 'NOT CREATED';
    manifestOutput.textContent = 'No manifest preview was produced.';
    setMessage(manifestMessage, error?.message || 'Could not create a manifest preview.', 'error');
  }
});

MANIFEST_DOWNLOAD.addEventListener('click', () => {
  if (!latestManifest) return;
  downloadJson(`${latestManifest.manifest.crate}-${latestManifest.manifest.version}-manifest-preview.json`, {
    manifest: latestManifest.manifest,
    manifest_sha256: latestManifest.manifestSha256,
    hash_method: 'SHA-256 per raw file bytes; preview digest is SHA-256 over UTF-8 canonical JSON with sorted object keys and retained array order.',
    status: 'PROPOSED / NOT SEALED',
    note: 'This is a local showcase preview, not a formal CUP manifest or seal.',
  });
});

function validSnapshotShape(snapshot) {
  return snapshot && typeof snapshot.id === 'string' && typeof snapshot.artifact === 'string'
    && typeof snapshot.name === 'string' && typeof snapshot.content === 'string'
    && Number.isSafeInteger(snapshot.bytes) && snapshot.bytes >= 0
    && typeof snapshot.sha256 === 'string' && HEX_256.test(snapshot.sha256)
    && typeof snapshot.createdAt === 'string';
}

let storageBlocked = false;

function loadLocalData() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return { snapshots: [], cuts: [], warning: '' };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.snapshots) || !Array.isArray(parsed.cuts)) {
      storageBlocked = true;
      return { snapshots: [], cuts: [], warning: 'Saved local data has an unexpected shape. It was not overwritten; clear this browser demo only if you intend to discard it.' };
    }
    const snapshots = parsed.snapshots.filter(validSnapshotShape).slice(-MAX_SNAPSHOTS);
    const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const cuts = parsed.cuts.filter((cut) => cut && typeof cut.id === 'string'
      && typeof cut.runLabel === 'string' && typeof cut.snapshotId === 'string'
      && snapshotById.has(cut.snapshotId) && typeof cut.sha256 === 'string' && HEX_256.test(cut.sha256)
      && cut.sha256 === snapshotById.get(cut.snapshotId).sha256
      && cut.artifact === snapshotById.get(cut.snapshotId).artifact
      && cut.stateName === snapshotById.get(cut.snapshotId).name)
      .slice(-MAX_CUTS);
    const warning = snapshots.length !== parsed.snapshots.length || cuts.length !== parsed.cuts.length
      ? 'Some malformed local records were hidden, not deleted. This browser storage is editable and is not an integrity-protected ledger.' : '';
    if (warning) storageBlocked = true;
    return { snapshots, cuts, warning };
  } catch {
    storageBlocked = true;
    return { snapshots: [], cuts: [], warning: 'Could not read local demo storage. Existing browser data was left untouched.' };
  }
}
let localData = loadLocalData();
let integrityWarning = localData.warning;

async function validateStoredSnapshotHashes() {
  if (!localData.snapshots.length) return;
  const valid = [];
  for (const snapshot of localData.snapshots) {
    try {
      const actualBytes = new TextEncoder().encode(snapshot.content).byteLength;
      const actualHash = await sha256Hex(snapshot.content);
      if (actualBytes === snapshot.bytes && actualHash === snapshot.sha256) valid.push(snapshot);
      else {
        storageBlocked = true;
        integrityWarning = 'One or more stored text snapshots no longer match their recorded size or SHA-256. They remain in browser storage but are hidden from this view.';
      }
    } catch {
      valid.push(snapshot);
      integrityWarning = 'Stored snapshot hashes could not be recomputed in this context. Use HTTPS or localhost to run SHA-256 checks.';
      break;
    }
  }
  if (valid.length !== localData.snapshots.length) {
    storageBlocked = true;
    const validIds = new Set(valid.map((snapshot) => snapshot.id));
    localData = { ...localData, snapshots: valid, cuts: localData.cuts.filter((cut) => validIds.has(cut.snapshotId)) };
  }
}

function persistLocalData(nextData) {
  if (storageBlocked) {
    integrityWarning = 'Local data is read-only because saved records could not be safely verified. Clear this browser demo only if you accept discarding the existing data.';
    $('#snapshot-message').textContent = integrityWarning;
    $('#snapshot-message').classList.add('is-error');
    return false;
  }
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ snapshots: nextData.snapshots, cuts: nextData.cuts }));
    return true;
  } catch (error) {
    integrityWarning = 'Could not save local browser data. Nothing was added to the on-screen history.';
    $('#snapshot-message').textContent = `${integrityWarning}${error?.name ? ` (${error.name})` : ''}`;
    $('#snapshot-message').classList.add('is-error');
    return false;
  }
}

const snapshotForm = $('#snapshot-form');
const snapshotMessage = $('#snapshot-message');
const snapshotList = $('#snapshot-list');
const snapshotCount = $('#snapshot-count');
const compareLeft = $('#compare-left');
const compareRight = $('#compare-right');
const cutSnapshot = $('#cut-snapshot');
const cutMessage = $('#cut-message');
const cutList = $('#cut-list');
const cutCount = $('#cut-count');
const exportLocalButton = $('#download-local-data');

function optionLabel(snapshot) {
  return `${snapshot.artifact} / ${snapshot.name} · ${snapshot.sha256.slice(0, 12)}…`;
}

function fillSnapshotSelect(select, preferred, fallbackIndex = 0) {
  const options = [];
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = localData.snapshots.length ? 'Choose a named state' : 'No named states yet';
  options.push(placeholder);
  for (const snapshot of localData.snapshots) {
    const option = document.createElement('option');
    option.value = snapshot.id;
    option.textContent = optionLabel(snapshot);
    options.push(option);
  }
  select.replaceChildren(...options);
  const existingIds = localData.snapshots.map((snapshot) => snapshot.id);
  if (preferred && existingIds.includes(preferred)) select.value = preferred;
  else if (existingIds.length) select.value = existingIds[Math.min(fallbackIndex, existingIds.length - 1)];
  else select.value = '';
}

function renderSnapshotList() {
  snapshotCount.textContent = `${localData.snapshots.length} named state${localData.snapshots.length === 1 ? '' : 's'}`;
  snapshotList.replaceChildren();
  if (!localData.snapshots.length) {
    appendText(snapshotList, 'p', 'Your named states will appear here. Add two with the same logical artifact name to see a fork.', 'empty-state');
  }
  for (const snapshot of [...localData.snapshots].reverse()) {
    const card = document.createElement('article');
    card.className = 'snapshot-card';
    appendText(card, 'h4', `${snapshot.artifact} / ${snapshot.name}`);
    appendText(card, 'p', `${snapshot.bytes} UTF-8 bytes · SHA-256 ${snapshot.sha256}`, 'hash-line');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Show stored text bytes';
    details.append(summary);
    const pre = document.createElement('pre');
    pre.textContent = snapshot.content;
    details.append(pre);
    card.append(details);
    snapshotList.append(card);
  }
  fillSnapshotSelect(compareLeft, compareLeft.value, 0);
  fillSnapshotSelect(compareRight, compareRight.value, Math.min(1, localData.snapshots.length - 1));
  fillSnapshotSelect(cutSnapshot, cutSnapshot.value, Math.max(0, localData.snapshots.length - 1));
  $('#snapshot-form button[type="submit"]').disabled = storageBlocked;
  $('#load-toy-pair').disabled = storageBlocked;
  $('#compare-form button[type="submit"]').disabled = localData.snapshots.length < 2;
  $('#cut-form button[type="submit"]').disabled = storageBlocked || localData.snapshots.length === 0;
  exportLocalButton.disabled = localData.snapshots.length === 0 && localData.cuts.length === 0;
  renderCutList();
  if (integrityWarning) setMessage(snapshotMessage, integrityWarning, 'error');
}

function renderCutList() {
  cutCount.textContent = `${localData.cuts.length} cut choice${localData.cuts.length === 1 ? '' : 's'}`;
  cutList.replaceChildren();
  if (!localData.cuts.length) {
    appendText(cutList, 'p', 'A local cut record names one existing state and one run label. It does not establish that the run happened.', 'empty-state');
    return;
  }
  for (const cut of [...localData.cuts].reverse()) {
    const row = document.createElement('article');
    row.className = 'cut-row';
    appendText(row, 'strong', `${cut.artifact} / ${cut.stateName}`);
    appendText(row, 'span', `Scope: ${cut.runLabel}`);
    appendText(row, 'code', `SHA-256 ${cut.sha256}`);
    appendText(row, 'small', `${cut.status} · ${cut.createdAt}`);
    cutList.append(row);
  }
}

async function addSnapshots(records) {
  if (storageBlocked) throw new Error(integrityWarning || 'Saved local data is read-only; clear this browser demo only if you accept discarding it.');
  if (localData.snapshots.length + records.length > MAX_SNAPSHOTS) throw new Error(`This local demo keeps at most ${MAX_SNAPSHOTS} text states.`);
  const known = new Set(localData.snapshots.map((snapshot) => `${snapshot.artifact}\u0000${snapshot.name}`));
  for (const record of records) {
    const key = `${record.artifact.trim()}\u0000${record.name.trim()}`;
    if (known.has(key)) throw new Error(`The named state “${record.artifact} / ${record.name}” already exists. Use a new name; old states are not overwritten.`);
    known.add(key);
  }
  const created = [];
  for (const record of records) created.push(await makeSnapshot(record));
  const nextData = { snapshots: [...localData.snapshots, ...created], cuts: localData.cuts };
  if (!persistLocalData(nextData)) throw new Error('Local storage did not accept the new state; the on-screen list was not changed.');
  localData = nextData;
  renderSnapshotList();
  return created;
}

snapshotForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const created = await addSnapshots([{
      artifact: $('#artifact-name').value,
      name: $('#snapshot-name').value,
      content: $('#snapshot-content').value,
    }]);
    cutSnapshot.value = created[0].id;
    setMessage(snapshotMessage, `Preserved ${created[0].artifact} / ${created[0].name} in this browser. The stored text bytes are UTF-8 bytes of the textarea value.`, 'success');
  } catch (error) {
    setMessage(snapshotMessage, error?.message || 'Could not preserve the named state.', 'error');
  }
});

$('#load-toy-pair').addEventListener('click', async () => {
  const examples = [
    { artifact: 'forecast-rule', name: 'candidate-a', content: '{\n  "threshold": 4,\n  "policy": "hold"\n}' },
    { artifact: 'forecast-rule', name: 'candidate-b', content: '{\n  "threshold": 5,\n  "policy": "keep-both"\n}' },
  ];
  try {
    const created = await addSnapshots(examples);
    setMessage(snapshotMessage, `Added two explicitly labeled toy states: ${created.map((item) => item.name).join(' and ')}. They are preserved side by side; no merge was attempted.`, 'success');
  } catch (error) {
    setMessage(snapshotMessage, error?.message || 'Could not add the toy fork pair.', 'error');
  }
});

$('#compare-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const left = localData.snapshots.find((snapshot) => snapshot.id === compareLeft.value);
  const right = localData.snapshots.find((snapshot) => snapshot.id === compareRight.value);
  const output = $('#compare-output');
  output.replaceChildren();
  try {
    const result = compareSnapshots(left, right);
    let description;
    if (!result.sameArtifact) description = 'These states have different logical artifact names. They are shown side by side, not treated as a fork of one artifact.';
    else if (result.sameBytes) description = 'These named states have matching stored size and SHA-256. This is a local byte comparison, not an authenticity claim.';
    else description = 'These are different named byte-states of the same logical artifact. Both remain preserved here; no merge or winner was selected.';
    appendText(output, 'p', description, 'compare-summary');
    const columns = document.createElement('div');
    columns.className = 'compare-columns';
    for (const [label, snapshot] of [['STATE A', left], ['STATE B', right]]) {
      const section = document.createElement('section');
      appendText(section, 'h4', `${label} · ${snapshot.artifact} / ${snapshot.name}`);
      appendText(section, 'code', `SHA-256 ${snapshot.sha256}`);
      appendText(section, 'pre', snapshot.content);
      columns.append(section);
    }
    output.append(columns);
    setMessage($('#compare-message'), 'Both selected states are displayed without automatic merge.', 'success');
  } catch (error) {
    appendText(output, 'p', error?.message || 'Choose two available states.');
    setMessage($('#compare-message'), error?.message || 'Choose two available states.', 'error');
  }
});

$('#cut-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    if (localData.cuts.length >= MAX_CUTS) throw new Error(`This local demo keeps at most ${MAX_CUTS} cut choices.`);
    const cut = makeCut(localData.snapshots, cutSnapshot.value, $('#cut-run-label').value);
    const nextData = { snapshots: localData.snapshots, cuts: [...localData.cuts, cut] };
    if (!persistLocalData(nextData)) throw new Error('Local storage did not accept the cut record.');
    localData = nextData;
    renderSnapshotList();
    setMessage(cutMessage, `Recorded a local cut choice for ${cut.stateName} / ${cut.runLabel}. This does not establish a run or release.`, 'success');
  } catch (error) {
    setMessage(cutMessage, error?.message || 'Could not record the cut choice.', 'error');
  }
});

exportLocalButton.addEventListener('click', () => {
  downloadJson('cup-showcase-local-review-data.json', {
    status: 'LOCAL DEMO EXPORT — NOT A SEALED CRATE',
    exportedAt: new Date().toISOString(),
    snapshots: localData.snapshots,
    cuts: localData.cuts,
    note: 'Snapshot content is UTF-8 text copied from browser textareas. The cut records name a choice, not a verified run. This export is editable and has no signature.',
  });
});

$('#clear-local-data').addEventListener('click', () => {
  if (!window.confirm('Clear this showcase’s local text snapshots and cut choices from this browser? This cannot be undone unless you downloaded an export.')) return;
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
    storageBlocked = false;
    localData = { snapshots: [], cuts: [] };
    integrityWarning = '';
    $('#compare-output').replaceChildren();
    appendText($('#compare-output'), 'p', 'Comparison will appear here. Both versions remain available; there is no automatic merge button.');
    setMessage(snapshotMessage, 'Local showcase data cleared from this browser. Nothing was sent anywhere.', 'success');
    setMessage(cutMessage, 'Local cut records cleared. Nothing was sent anywhere.', 'success');
    renderSnapshotList();
  } catch (error) {
    setMessage(snapshotMessage, `Could not clear local browser storage (${error?.name || 'storage error'}).`, 'error');
  }
});

const runChecksButton = $('#run-checks');
const checksSummary = $('#checks-summary');
const checksList = $('#checks-list');
runChecksButton.addEventListener('click', async () => {
  runChecksButton.disabled = true;
  checksSummary.textContent = 'Running checks against the functions used by this page…';
  checksList.replaceChildren();
  const results = await runSelfChecks();
  let passed = 0;
  for (const result of results) {
    if (result.passed) passed += 1;
    const row = document.createElement('li');
    row.className = result.passed ? 'check-passed' : 'check-failed';
    appendText(row, 'strong', result.passed ? 'PASS' : 'FAIL');
    appendText(row, 'span', result.name);
    appendText(row, 'small', result.detail);
    checksList.append(row);
  }
  checksSummary.textContent = `${passed}/${results.length} checks passed in this browser. These checks cover only the listed toy behaviors.`;
  runChecksButton.disabled = false;
});

await validateStoredSnapshotHashes();
renderSnapshotList();
if (integrityWarning) setMessage(snapshotMessage, integrityWarning, 'error');
