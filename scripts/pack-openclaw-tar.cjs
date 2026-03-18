'use strict';

/**
 * pack-openclaw-tar.cjs
 *
 * Packs a directory into a single .tar file for Windows distribution.
 * NSIS installs thousands of small files very slowly on NTFS; shipping one
 * tar archive and extracting it post-install is dramatically faster.
 *
 * Used by electron-builder-hooks beforePack to pack:
 *   - OpenClaw runtime (vendor/openclaw-runtime/current -> cfmind.tar)
 *   - SKILLs directory (SKILLs -> skills.tar)
 *   - Python runtime (resources/python-win -> python-win.tar)
 *
 * Usage (standalone):
 *   node scripts/pack-openclaw-tar.cjs [sourceDir] [outputTar]
 *
 * The tar is NOT gzip-compressed — the outer NSIS 7z solid archive already
 * compresses, so double-compression would only waste CPU.
 */

const fs = require('fs');
const path = require('path');

// ── Minimal tar writer ──────────────────────────────────────────────────────
// Implements just enough of the POSIX ustar format to pack regular files and
// directories.  No external dependencies.

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK, 0);

function toOctal(num, len) {
  return num.toString(8).padStart(len - 1, '0') + '\0';
}

function createHeader(name, size, mode, type) {
  // type: '0' = regular file, '5' = directory, 'L' = GNU long name
  const buf = Buffer.alloc(BLOCK, 0);

  // If name fits in 100 bytes, use it directly
  // If name > 100 but <= 255, try prefix/name split
  // If name > 255, caller must use GNU long name extension
  let prefix = '';
  let shortName = name;
  const nameBytes = Buffer.byteLength(name);

  if (nameBytes > 100) {
    const sepIdx = name.lastIndexOf('/', name.length - 2);
    if (sepIdx > 0 && Buffer.byteLength(name.slice(sepIdx + 1)) <= 100 && Buffer.byteLength(name.slice(0, sepIdx)) <= 155) {
      prefix = name.slice(0, sepIdx);
      shortName = name.slice(sepIdx + 1);
    } else {
      // Truncate to 100 bytes — caller should have used writeLongNameEntry() for this
      shortName = name.slice(0, 100);
    }
  }

  buf.write(shortName, 0, 100);                  // name
  buf.write(toOctal(mode, 8), 100, 8);            // mode
  buf.write(toOctal(0, 8), 108, 8);               // uid
  buf.write(toOctal(0, 8), 116, 8);               // gid
  buf.write(toOctal(size, 12), 124, 12);           // size
  buf.write(toOctal(Math.floor(Date.now() / 1000), 12), 136, 12); // mtime
  buf.write('        ', 148, 8);                   // checksum placeholder
  buf.write(type, 156, 1);                         // typeflag
  buf.write('ustar\0', 257, 6);                    // magic
  buf.write('00', 263, 2);                          // version
  if (prefix) {
    buf.write(prefix, 345, 155);                   // prefix
  }

  // Compute checksum
  let chksum = 0;
  for (let i = 0; i < BLOCK; i++) {
    chksum += buf[i];
  }
  buf.write(toOctal(chksum, 7), 148, 7);
  buf[155] = 0x20; // trailing space

  return buf;
}

/**
 * Write a GNU long name (type 'L') entry for paths that exceed ustar limits.
 * GNU tar stores the full path as data in a special entry before the real header.
 */
function writeLongNameEntry(fd, longName) {
  const nameData = Buffer.from(longName + '\0', 'utf8');
  const header = createHeader('././@LongLink', nameData.length, 0, 'L');
  fs.writeSync(fd, header);
  fs.writeSync(fd, nameData);
  // Pad to 512-byte boundary
  const pad = padBlock(nameData.length);
  if (pad.length > 0) {
    fs.writeSync(fd, pad);
  }
}

/**
 * Check if a path needs GNU long name extension.
 */
function needsLongName(name) {
  const nameBytes = Buffer.byteLength(name);
  if (nameBytes <= 100) return false;
  // Try prefix/name split
  const sepIdx = name.lastIndexOf('/', name.length - 2);
  if (sepIdx > 0) {
    const shortPart = name.slice(sepIdx + 1);
    const prefixPart = name.slice(0, sepIdx);
    if (Buffer.byteLength(shortPart) <= 100 && Buffer.byteLength(prefixPart) <= 155) {
      return false;
    }
  }
  return true;
}

function padBlock(size) {
  const remainder = size % BLOCK;
  if (remainder === 0) return Buffer.alloc(0);
  return Buffer.alloc(BLOCK - remainder, 0);
}

// ── File/dir exclusion rules (same as electron-builder.json filters) ─────────

const EXCLUDED_FILE_PATTERNS = [
  /\.map$/i,
  /\.d\.ts$/i,
  /\.d\.cts$/i,
  /\.d\.mts$/i,
  /^readme(\.(md|txt|rst))?$/i,
  /^changelog(\.(md|txt|rst))?$/i,
  /^history(\.(md|txt|rst))?$/i,
  /^license(\.(md|txt))?$/i,
  /^licence(\.(md|txt))?$/i,
  /^authors(\.(md|txt))?$/i,
  /^contributors(\.(md|txt))?$/i,
  /^\.eslintrc/i,
  /^\.prettierrc/i,
  /^\.editorconfig$/i,
  /^\.npmignore$/i,
  /^\.gitignore$/i,
  /^\.gitattributes$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^jest\.config/i,
  /^vitest\.config/i,
  /^\.babelrc/i,
  /^babel\.config/i,
  /\.test\.\w+$/i,
  /\.spec\.\w+$/i,
];

const EXCLUDED_DIRS = new Set([
  'test',
  'tests',
  '__tests__',
  '__mocks__',
  '.github',
  'example',
  'examples',
  'coverage',
  '.venv',
]);

const EXCLUDED_ENVFILE = /^\.env(\..+)?$/i;

function shouldExcludeFile(name) {
  if (EXCLUDED_ENVFILE.test(name)) return true;
  return EXCLUDED_FILE_PATTERNS.some((p) => p.test(name));
}

function shouldExcludeDir(name) {
  return EXCLUDED_DIRS.has(name.toLowerCase());
}

function packDirectory(sourceDir, outputTar) {
  const fd = fs.openSync(outputTar, 'w');
  let totalFiles = 0;
  let totalDirs = 0;
  let skippedFiles = 0;

  function walk(dir, prefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    // Sort for deterministic output
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const tarPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) {
        // Skip symlinks — Windows NTFS junctions and symlinks in node_modules
        // cause issues; the runtime doesn't need .bin symlinks.
        continue;
      }

      if (entry.isDirectory()) {
        if (shouldExcludeDir(entry.name)) continue;
        const dirTarPath = tarPath + '/';
        if (needsLongName(dirTarPath)) {
          writeLongNameEntry(fd, dirTarPath);
        }
        const dirHeader = createHeader(dirTarPath, 0, 0o755, '5');
        fs.writeSync(fd, dirHeader);
        totalDirs++;
        walk(fullPath, tarPath);
      } else if (entry.isFile()) {
        if (shouldExcludeFile(entry.name)) {
          skippedFiles++;
          continue;
        }
        if (needsLongName(tarPath)) {
          writeLongNameEntry(fd, tarPath);
        }
        const stat = fs.statSync(fullPath);
        const fileSize = stat.size;
        const header = createHeader(tarPath, fileSize, 0o644, '0');
        fs.writeSync(fd, header);

        // Stream file content in chunks to avoid loading large files into memory
        const CHUNK = 1024 * 1024; // 1 MB
        const readFd = fs.openSync(fullPath, 'r');
        let offset = 0;
        while (offset < fileSize) {
          const toRead = Math.min(CHUNK, fileSize - offset);
          const chunk = Buffer.alloc(toRead);
          fs.readSync(readFd, chunk, 0, toRead, offset);
          fs.writeSync(fd, chunk);
          offset += toRead;
        }
        fs.closeSync(readFd);

        // Pad to 512-byte boundary
        const pad = padBlock(fileSize);
        if (pad.length > 0) {
          fs.writeSync(fd, pad);
        }

        totalFiles++;
      }
    }
  }

  /**
   * Add a source directory to the tar with a custom root prefix.
   * e.g. addSource('/path/to/current', 'cfmind') puts all files under cfmind/ in the tar.
   */
  function addSource(sourceDir, rootPrefix) {
    // Write root directory entry
    const rootTarPath = rootPrefix + '/';
    const rootHeader = createHeader(rootTarPath, 0, 0o755, '5');
    fs.writeSync(fd, rootHeader);
    totalDirs++;
    walk(sourceDir, rootPrefix);
  }

  return { fd, addSource, finalize() {
    // End-of-archive marker: two zero blocks
    fs.writeSync(fd, ZERO_BLOCK);
    fs.writeSync(fd, ZERO_BLOCK);
    fs.closeSync(fd);
    return { totalFiles, totalDirs, skippedFiles };
  }};
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const projectRoot = path.join(__dirname, '..');

  // Support two modes:
  // 1. Single dir: node pack-openclaw-tar.cjs [sourceDir] [outputTar]
  // 2. Windows combined: node pack-openclaw-tar.cjs --win-combined
  const isWinCombined = process.argv.includes('--win-combined');

  if (isWinCombined) {
    const outputTar = path.join(projectRoot, 'build-tar', 'win-resources.tar');
    fs.mkdirSync(path.dirname(outputTar), { recursive: true });

    const sources = [
      { dir: path.join(projectRoot, 'vendor', 'openclaw-runtime', 'current'), prefix: 'cfmind' },
      { dir: path.join(projectRoot, 'SKILLs'), prefix: 'SKILLs' },
      { dir: path.join(projectRoot, 'resources', 'python-win'), prefix: 'python-win' },
    ];

    console.log(`[pack-openclaw-tar] Packing combined Windows tar: ${outputTar}`);
    const t0 = Date.now();
    const packer = packDirectory(null, outputTar);

    for (const { dir, prefix } of sources) {
      if (!fs.existsSync(dir)) {
        console.log(`[pack-openclaw-tar]   Skipping ${prefix}: ${dir} not found`);
        continue;
      }
      console.log(`[pack-openclaw-tar]   Adding ${prefix} ← ${dir}`);
      packer.addSource(dir, prefix);
    }

    const { totalFiles, totalDirs, skippedFiles } = packer.finalize();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const stat = fs.statSync(outputTar);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    console.log(
      `[pack-openclaw-tar] Done in ${elapsed}s: ${totalFiles} files, ${totalDirs} dirs, ${skippedFiles} skipped, ${sizeMB} MB`
    );
    return;
  }

  // Single directory mode (original behavior)
  const sourceDir = process.argv[2]
    || path.join(projectRoot, 'vendor', 'openclaw-runtime', 'current');
  const outputTar = process.argv[3]
    || path.join(projectRoot, 'vendor', 'openclaw-runtime', 'cfmind.tar');

  if (!fs.existsSync(sourceDir)) {
    console.error(`[pack-openclaw-tar] Source directory not found: ${sourceDir}`);
    process.exit(1);
  }

  console.log(`[pack-openclaw-tar] Packing: ${sourceDir}`);
  console.log(`[pack-openclaw-tar] Output:  ${outputTar}`);

  const t0 = Date.now();
  const packer = packDirectory(null, outputTar);
  packer.addSource(sourceDir, path.basename(sourceDir));
  const { totalFiles, totalDirs, skippedFiles } = packer.finalize();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const stat = fs.statSync(outputTar);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);

  console.log(
    `[pack-openclaw-tar] Done in ${elapsed}s: ${totalFiles} files, ${totalDirs} dirs, ${skippedFiles} skipped, ${sizeMB} MB`
  );
}

// Only run main() when invoked directly (not when require()'d by another module)
if (require.main === module) {
  main();
}

module.exports = { packDirectory };
