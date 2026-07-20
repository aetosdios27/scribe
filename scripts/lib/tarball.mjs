import { gunzipSync } from "node:zlib";

export function readTarball(buffer) {
  const archive = gunzipSync(buffer);
  const entries = [];

  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const mode = readOctal(header, 100, 8);
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;

    if (bodyEnd > archive.length) throw new Error(`Invalid tarball entry ${path}: content exceeds archive size.`);
    entries.push({
      path,
      mode,
      size,
      type,
      content: archive.subarray(bodyStart, bodyEnd)
    });

    offset = bodyStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function readString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  const boundary = end === -1 || end > offset + length ? offset + length : end;
  return buffer.subarray(offset, boundary).toString("utf8").trim();
}

function readOctal(buffer, offset, length) {
  const value = readString(buffer, offset, length).replace(/^\s+|\s+$/gu, "");
  if (!value) return 0;
  const parsed = Number.parseInt(value, 8);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid tar size field: ${JSON.stringify(value)}.`);
  return parsed;
}
