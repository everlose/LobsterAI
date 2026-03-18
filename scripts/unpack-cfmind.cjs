'use strict';

/**
 * unpack-cfmind.cjs
 *
 * Extracts a .tar archive into a target directory.  Designed to run during
 * NSIS post-install using Electron's Node runtime (ELECTRON_RUN_AS_NODE=1).
 *
 * Usage:
 *   node unpack-cfmind.cjs <tarPath> <destDir>
 *
 * - Zero external dependencies — uses only Node.js built-ins.
 * - Implements a minimal POSIX ustar tar reader (regular files + directories).
 * - Skips symlinks (not needed on Windows).
 * - Exits with code 0 on success, non-zero on failure.
 */

const fs = require('fs');
const path = require('path');

const BLOCK = 512;

// ── Minimal tar reader ──────────────────────────────────────────────────────

function parseOctal(buf, offset, length) {
  // Trim trailing nulls and spaces, then parse as octal
  let str = '';
  for (let i = offset; i < offset + length; i++) {
    const ch = buf[i];
    if (ch === 0 || ch === 0x20) break;
    str += String.fromCharCode(ch);
  }
  if (str.length === 0) return 0;
  return parseInt(str, 8) || 0;
}

function parseName(buf, offset, length) {
  let end = offset;
  while (end < offset + length && buf[end] !== 0) {
    end++;
  }
  return buf.toString('utf8', offset, end);
}

function isZeroBlock(buf, offset) {
  for (let i = offset; i < offset + BLOCK; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

function extractTar(tarPath, destDir) {
  const fd = fs.openSync(tarPath, 'r');
  const tarStat = fs.fstatSync(fd);
  const tarSize = tarStat.size;

  let offset = 0;
  let totalFiles = 0;
  let totalDirs = 0;
  let zeroBlockCount = 0;

  const headerBuf = Buffer.alloc(BLOCK);

  // Pre-create destDir
  fs.mkdirSync(destDir, { recursive: true });

  // Track created directories to avoid redundant mkdirSync calls
  const createdDirs = new Set();
  createdDirs.add(path.resolve(destDir));

  function ensureParentDir(filePath) {
    const dir = path.dirname(filePath);
    const resolved = path.resolve(dir);
    if (createdDirs.has(resolved)) return;
    fs.mkdirSync(dir, { recursive: true });
    // Add this dir and all parents up to destDir
    let cur = resolved;
    const resolvedDest = path.resolve(destDir);
    while (cur.length >= resolvedDest.length && !createdDirs.has(cur)) {
      createdDirs.add(cur);
      cur = path.dirname(cur);
    }
  }

  while (offset + BLOCK <= tarSize) {
    const bytesRead = fs.readSync(fd, headerBuf, 0, BLOCK, offset);
    if (bytesRead < BLOCK) break;

    // Check for end-of-archive (two consecutive zero blocks)
    if (isZeroBlock(headerBuf, 0)) {
      zeroBlockCount++;
      if (zeroBlockCount >= 2) break;
      offset += BLOCK;
      continue;
    }
    zeroBlockCount = 0;

    // Parse header fields
    const name = parseName(headerBuf, 0, 100);
    const size = parseOctal(headerBuf, 124, 12);
    const typeflag = String.fromCharCode(headerBuf[156]);
    const prefix = parseName(headerBuf, 345, 155);

    const fullName = prefix ? `${prefix}/${name}` : name;

    // Security: prevent path traversal
    const normalizedName = fullName.replace(/\\/g, '/');
    if (normalizedName.startsWith('/') || normalizedName.includes('..')) {
      // Skip dangerous paths
      offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }

    const targetPath = path.join(destDir, normalizedName);

    offset += BLOCK; // Move past header

    if (typeflag === 'L') {
      // GNU long name extension: the data is the full path for the next entry
      const longNameBuf = Buffer.alloc(size);
      fs.readSync(fd, longNameBuf, 0, size, offset);
      // Remove trailing null
      let longName = longNameBuf.toString('utf8');
      if (longName.endsWith('\0')) longName = longName.slice(0, -1);
      // Skip padding
      const paddingBytes = (BLOCK - (size % BLOCK)) % BLOCK;
      offset += size + paddingBytes;

      // Read the actual header that follows
      fs.readSync(fd, headerBuf, 0, BLOCK, offset);
      const realSize = parseOctal(headerBuf, 124, 12);
      const realType = String.fromCharCode(headerBuf[156]);
      offset += BLOCK;

      const normalizedLongName = longName.replace(/\\/g, '/');
      if (normalizedLongName.startsWith('/') || normalizedLongName.includes('..')) {
        const dataBlocks = Math.ceil(realSize / BLOCK);
        offset += dataBlocks * BLOCK;
        continue;
      }

      const longTargetPath = path.join(destDir, normalizedLongName);

      if (realType === '5' || normalizedLongName.endsWith('/')) {
        if (!createdDirs.has(path.resolve(longTargetPath))) {
          fs.mkdirSync(longTargetPath, { recursive: true });
          createdDirs.add(path.resolve(longTargetPath));
        }
        totalDirs++;
      } else if (realType === '0' || realType === '\0') {
        ensureParentDir(longTargetPath);
        const writeFd = fs.openSync(longTargetPath, 'w');
        let remaining = realSize;
        const CHUNK = 1024 * 1024;
        while (remaining > 0) {
          const toRead = Math.min(CHUNK, remaining);
          const chunk = Buffer.alloc(toRead);
          fs.readSync(fd, chunk, 0, toRead, offset);
          fs.writeSync(writeFd, chunk, 0, toRead);
          offset += toRead;
          remaining -= toRead;
        }
        fs.closeSync(writeFd);
        const paddingBytesFile = (BLOCK - (realSize % BLOCK)) % BLOCK;
        offset += paddingBytesFile;
        totalFiles++;
      } else {
        const dataBlocks = Math.ceil(realSize / BLOCK);
        offset += dataBlocks * BLOCK;
      }
      continue;
    }

    if (typeflag === '5' || (typeflag === '0' && name.endsWith('/'))) {
      // Directory
      if (!createdDirs.has(path.resolve(targetPath))) {
        fs.mkdirSync(targetPath, { recursive: true });
        createdDirs.add(path.resolve(targetPath));
      }
      totalDirs++;
    } else if (typeflag === '0' || typeflag === '\0') {
      // Regular file
      ensureParentDir(targetPath);

      const writeFd = fs.openSync(targetPath, 'w');
      let remaining = size;
      const CHUNK = 1024 * 1024; // 1 MB

      while (remaining > 0) {
        const toRead = Math.min(CHUNK, remaining);
        const chunk = Buffer.alloc(toRead);
        fs.readSync(fd, chunk, 0, toRead, offset);
        fs.writeSync(writeFd, chunk, 0, toRead);
        offset += toRead;
        remaining -= toRead;
      }
      fs.closeSync(writeFd);

      // Skip padding to next 512-byte boundary
      const paddingBytes = (BLOCK - (size % BLOCK)) % BLOCK;
      offset += paddingBytes;

      totalFiles++;
    } else {
      // Skip unsupported entry types (symlinks, etc.)
      const dataBlocks = Math.ceil(size / BLOCK);
      offset += dataBlocks * BLOCK;
    }
  }

  fs.closeSync(fd);
  return { totalFiles, totalDirs };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const tarPath = process.argv[2];
  const destDir = process.argv[3];

  if (!tarPath || !destDir) {
    console.error('Usage: node unpack-cfmind.cjs <tarPath> <destDir>');
    process.exit(1);
  }

  if (!fs.existsSync(tarPath)) {
    console.error(`[unpack-cfmind] tar file not found: ${tarPath}`);
    process.exit(1);
  }

  const t0 = Date.now();
  console.log(`[unpack-cfmind] Extracting: ${tarPath}`);
  console.log(`[unpack-cfmind] Destination: ${destDir}`);

  try {
    const { totalFiles, totalDirs } = extractTar(tarPath, destDir);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[unpack-cfmind] Done in ${elapsed}s: ${totalFiles} files, ${totalDirs} dirs`
    );
  } catch (err) {
    console.error(`[unpack-cfmind] Extraction failed: ${err.message || err}`);
    process.exit(1);
  }
}

main();
