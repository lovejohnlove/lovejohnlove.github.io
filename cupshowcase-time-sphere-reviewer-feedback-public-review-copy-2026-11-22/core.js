export const PREVIEW_SCHEMA = 'cup-showcase-manifest-preview/v1';
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 16 * 1024;

const SHA256_RE = /^[a-f0-9]{64}$/;
const ZERO_ID = '00000000-0000-4000-8000-000000000000';

function getSubtle(subtle) {
  const available = subtle || globalThis.crypto?.subtle;
  if (!available || typeof available.digest !== 'function') {
    throw new Error('Web Crypto SHA-256 is unavailable. Open this draft on HTTPS or localhost; no weaker fallback is used.');
  }
  return available;
}

function asBytes(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected text, an ArrayBuffer, or a typed array.');
}

function normalizeJson(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON only supports finite numbers.');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Canonical JSON cannot contain cycles.');
    seen.add(value);
    const result = value.map((item) => normalizeJson(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON accepts plain JSON objects only.');
    }
    if (seen.has(value)) throw new TypeError('Canonical JSON cannot contain cycles.');
    seen.add(value);
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = normalizeJson(value[key], seen);
    seen.delete(value);
    return result;
  }
  throw new TypeError('Value is not representable as JSON.');
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeJson(value, new Set()));
}

export async function sha256Hex(value, subtle) {
  const digest = await getSubtle(subtle).digest('SHA-256', asBytes(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

export async function buildManifestFromRecords(fileRecords, metadata = {}, subtle) {
  if (!Array.isArray(fileRecords) || fileRecords.length === 0) {
    throw new Error('Choose at least one file before creating a preview.');
  }
  const names = new Set();
  const files = fileRecords.map((record) => {
    if (!record || typeof record.name !== 'string' || !record.name.trim()) {
      throw new Error('Every manifest entry needs a non-empty file name.');
    }
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) {
      throw new Error(`Invalid byte count for ${record.name}.`);
    }
    if (typeof record.sha256 !== 'string' || !SHA256_RE.test(record.sha256)) {
      throw new Error(`Invalid SHA-256 digest for ${record.name}.`);
    }
    const name = record.name.trim();
    if (names.has(name)) throw new Error(`Duplicate file path in manifest preview: ${name}`);
    names.add(name);
    return { name, bytes: record.bytes, sha256: record.sha256 };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  const crate = cleanText(metadata.crate, 'untitled-demo');
  const version = cleanText(metadata.version, '0.1.0-demo');
  if (crate.length > 120 || version.length > 80) throw new Error('Crate name or version is too long.');

  const manifest = {
    schema: PREVIEW_SCHEMA,
    status: 'PROPOSED / NOT SEALED',
    crate,
    version,
    files,
    intended_use: cleanText(metadata.intended_use),
    tested: cleanText(metadata.tested),
    uncertain: cleanText(metadata.uncertain),
    challenge: cleanText(metadata.challenge),
  };
  const manifestSha256 = await sha256Hex(new TextEncoder().encode(canonicalJson(manifest)), subtle);
  return { manifest, manifestSha256 };
}

export async function buildManifestPreview(fileList, metadata = {}, subtle) {
  const files = Array.from(fileList || []);
  if (!files.length) throw new Error('Choose at least one file before creating a preview.');
  let total = 0;
  const records = [];
  for (const file of files) {
    const name = file.webkitRelativePath || file.name;
    if (!name) throw new Error('A selected file has no name.');
    if (file.size > MAX_FILE_BYTES) throw new Error(`${name} is over the 20 MiB per-file demo limit.`);
    total += file.size;
    if (total > MAX_TOTAL_BYTES) throw new Error('Selected files exceed the 50 MiB total demo limit.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    records.push({ name, bytes: bytes.byteLength, sha256: await sha256Hex(bytes, subtle) });
  }
  return buildManifestFromRecords(records, metadata, subtle);
}

export async function verifyManifestPreview(preview, subtle) {
  if (!preview || !preview.manifest || typeof preview.manifest !== 'object') {
    return { valid: false, reason: 'Preview is missing its manifest object.' };
  }
  if (preview.manifest.schema !== PREVIEW_SCHEMA || preview.manifest.status !== 'PROPOSED / NOT SEALED') {
    return { valid: false, reason: 'Unexpected schema or status.' };
  }
  if (!Array.isArray(preview.manifest.files) || preview.manifest.files.length === 0) {
    return { valid: false, reason: 'Manifest has no file entries.' };
  }
  if (typeof preview.manifestSha256 !== 'string' || !SHA256_RE.test(preview.manifestSha256)) {
    return { valid: false, reason: 'Preview has no valid manifest SHA-256 field.' };
  }
  const names = new Set();
  for (const file of preview.manifest.files) {
    if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !SHA256_RE.test(file.sha256 || '')) {
      return { valid: false, reason: 'A file entry is malformed.' };
    }
    if (names.has(file.name)) return { valid: false, reason: `Duplicate file path: ${file.name}` };
    names.add(file.name);
  }
  const actual = await sha256Hex(new TextEncoder().encode(canonicalJson(preview.manifest)), subtle);
  if (actual !== preview.manifestSha256) return { valid: false, reason: 'Manifest preview digest does not match its current JSON.' };
  return {
    valid: true,
    reason: 'The manifest JSON matches its preview digest. File contents were not re-read; compare each file digest against the original bytes to verify those files.',
  };
}

export function makeLocalId(prefix = 'record') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

export async function makeSnapshot({ artifact, name, content, id = makeLocalId('snapshot'), createdAt = new Date().toISOString() }, subtle) {
  const artifactName = cleanText(artifact);
  const stateName = cleanText(name);
  if (!artifactName || artifactName.length > 120) throw new Error('Enter a logical artifact name (1–120 characters).');
  if (!stateName || stateName.length > 120) throw new Error('Enter a distinct byte-state name (1–120 characters).');
  if (typeof content !== 'string') throw new Error('Snapshot content must be text.');
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('Text snapshots are limited to 16 KiB each in this browser demo.');
  return {
    id,
    artifact: artifactName,
    name: stateName,
    content,
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes, subtle),
    createdAt,
    representation: 'UTF-8 bytes of the textarea value; not a copy of an external file',
  };
}

export function compareSnapshots(left, right) {
  if (!left || !right) throw new Error('Choose two named states to compare.');
  return {
    sameArtifact: left.artifact === right.artifact,
    sameBytes: left.bytes === right.bytes && left.sha256 === right.sha256,
    leftHash: left.sha256,
    rightHash: right.sha256,
    hasConflict: left.sha256 !== right.sha256,
  };
}

export function groupSnapshots(snapshots) {
  const groups = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot.artifact !== 'string') continue;
    if (!groups.has(snapshot.artifact)) groups.set(snapshot.artifact, []);
    groups.get(snapshot.artifact).push(snapshot);
  }
  return Array.from(groups, ([artifact, states]) => ({ artifact, states: [...states] }));
}

export function makeCut(snapshots, snapshotId, runLabel, { id = makeLocalId('cut'), createdAt = new Date().toISOString() } = {}) {
  const snapshot = snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) throw new Error('The selected named state is not in this browser’s local list.');
  const label = cleanText(runLabel);
  if (!label || label.length > 160) throw new Error('Enter a scoped run label (1–160 characters).');
  return {
    id,
    artifact: snapshot.artifact,
    stateName: snapshot.name,
    snapshotId: snapshot.id,
    sha256: snapshot.sha256,
    runLabel: label,
    createdAt,
    status: 'LOCAL CUT RECORD — NOT A BENCH RUN OR RELEASE',
  };
}

export async function runSelfChecks(subtle) {
  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, passed: detail === true || detail === undefined, detail: detail === true || detail === undefined ? 'passed' : String(detail) });
    } catch (error) {
      results.push({ name, passed: false, detail: error?.message || String(error) });
    }
  };

  await check('Canonical JSON sorts object keys', () => canonicalJson({ z: 1, a: { y: 2, b: 3 } }) === '{"a":{"b":3,"y":2},"z":1}');
  await check('SHA-256 matches the known “abc” test vector', async () => (await sha256Hex('abc', subtle)) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await check('Manifest digest changes if its metadata changes', async () => {
    const file = { name: 'sample.txt', bytes: 3, sha256: await sha256Hex('abc', subtle) };
    const first = await buildManifestFromRecords([file], { crate: 'demo', version: '1' }, subtle);
    const second = await buildManifestFromRecords([file], { crate: 'demo', version: '2' }, subtle);
    return first.manifestSha256 !== second.manifestSha256;
  });
  await check('Two named byte-states remain as a fork', () => {
    const states = [
      { id: 'a', artifact: 'same-work', name: 'state-a', sha256: 'a'.repeat(64) },
      { id: 'b', artifact: 'same-work', name: 'state-b', sha256: 'b'.repeat(64) },
    ];
    const group = groupSnapshots(states).find((item) => item.artifact === 'same-work');
    return Boolean(group && group.states.length === 2 && group.states[0].id !== group.states[1].id);
  });
  await check('A cut names one existing state and run label', () => {
    const state = { id: 'state-1', artifact: 'demo', name: 'candidate-a', sha256: 'c'.repeat(64) };
    const cut = makeCut([state], state.id, 'demo-run-1', { id: 'cut-1', createdAt: '2026-01-01T00:00:00.000Z' });
    return cut.snapshotId === state.id && cut.runLabel === 'demo-run-1' && makeCut([state], state.id, 'demo-run-1').status.startsWith('LOCAL CUT RECORD');
  });
  return results;
}
