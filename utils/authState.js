const fs = require('fs');
const path = require('path');

// creds.json holds the linked-device identity. Baileys writes it non-atomically
// (truncate, then write), and if it can't parse it on startup it silently
// generates a brand-new identity — indistinguishable from being logged out.
// These helpers make the write crash-safe and keep a last-known-good backup.

const credsPath = (folder) => path.join(folder, 'creds.json');
const backupPath = (folder) => `${credsPath(folder)}.bak`;

function isValidCreds(file) {
  try {
    const creds = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Boolean(creds && creds.noiseKey && creds.signedIdentityKey);
  } catch {
    return false;
  }
}

// Write to a temp file, fsync, then rename over the target — readers only
// ever see the old file or the complete new one, even on crash/power loss
async function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const handle = await fs.promises.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(tmp, file);
}

/**
 * Call before Baileys loads the folder. Restores creds.json from the backup
 * when it is missing or unreadable.
 * @returns {boolean} true if a restore happened
 */
function restoreCredsIfCorrupt(folder, logger) {
  const file = credsPath(folder);
  const backup = backupPath(folder);
  if (fs.existsSync(file) && isValidCreds(file)) return false;
  if (!isValidCreds(backup)) {
    if (fs.existsSync(file)) {
      logger.error('creds.json is corrupt and no valid backup exists — a new QR scan will be needed');
    }
    return false;
  }
  fs.copyFileSync(backup, file);
  logger.warn('creds.json was missing or corrupt — restored from creds.json.bak');
  return true;
}

/**
 * Crash-safe replacement for Baileys' saveCreds. Writes are serialized so
 * rapid creds.update events can't interleave.
 */
function makeAtomicSaveCreds(folder, creds, BufferJSON, logger) {
  let chain = Promise.resolve();
  return () => {
    chain = chain
      .then(() => writeFileAtomic(credsPath(folder), JSON.stringify(creds, BufferJSON.replacer)))
      .catch((error) => logger.error({ err: error }, 'Failed to save creds.json'));
    return chain;
  };
}

/**
 * Snapshot creds.json as last-known-good. Only call once the session is
 * proven to work (connection 'open'), so a bad identity never replaces it.
 */
async function backupCreds(folder, logger) {
  try {
    if (!isValidCreds(credsPath(folder))) return;
    await writeFileAtomic(backupPath(folder), await fs.promises.readFile(credsPath(folder)));
  } catch (error) {
    logger.error({ err: error }, 'Failed to back up creds.json');
  }
}

module.exports = { restoreCredsIfCorrupt, makeAtomicSaveCreds, backupCreds };
