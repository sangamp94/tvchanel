const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_DIR = path.join(__dirname, "..", "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function keyFor(url) {
  return crypto.createHash("md5").update(url).digest("hex");
}

function extFromUrl(url) {
  const match = url.split("?")[0].match(/\.(png|jpg|jpeg|webp|gif)$/i);
  return match ? match[1].toLowerCase() : "png";
}

/**
 * Downloads a logo image URL to a local cache file (only re-downloads if not
 * already cached). Returns the local file path, or null if download fails
 * (callers should skip that overlay layer rather than crash the stream).
 */
async function getLocalPath(url) {
  if (!url) return null;
  const ext = extFromUrl(url);
  const filePath = path.join(CACHE_DIR, `${keyFor(url)}.${ext}`);

  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    return filePath;
  }

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buf);
    return filePath;
  } catch (e) {
    console.warn(`[logoCache] Failed to download logo "${url}": ${e.message}`);
    return null;
  }
}

module.exports = { getLocalPath };
