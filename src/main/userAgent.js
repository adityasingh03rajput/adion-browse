/**
 * Shared browser identity.
 *
 * The app presents itself as desktop Chrome so web apps do not reject an
 * embedded Chromium build. Derive the version from the running engine instead
 * of hardcoding it: a UA that claims a different Chrome version than the
 * actual Chromium build (and than the sec-ch-ua client hints) is an obvious
 * mismatch for sites that validate consistency.
 */
const CHROME_FULL_VERSION = process.versions.chrome || '0.0.0.0';
const CHROME_MAJOR = CHROME_FULL_VERSION.split('.')[0];

const CHROME_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

const SEC_CH_UA = `"Not_A Brand";v="99", "Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}"`;

module.exports = { CHROME_FULL_VERSION, CHROME_MAJOR, CHROME_USER_AGENT, SEC_CH_UA };
