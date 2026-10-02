const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 64 * 1024 * 1024;
const DUMMY_SALT = Buffer.alloc(16, 0x5a);
const DUMMY_HASH = crypto.scryptSync("not-a-real-password", DUMMY_SALT, KEY_LENGTH, {
  N: COST, r: BLOCK_SIZE, p: PARALLELIZATION, maxmem: MAX_MEMORY
});

function validateUsername(value) {
  if (typeof value !== "string") return null;
  const username = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) ? username : null;
}

function validatePassword(value) {
  return typeof value === "string" && value.length >= 6 && value.length <= 128;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, {
    N: COST, r: BLOCK_SIZE, p: PARALLELIZATION, maxmem: MAX_MEMORY
  });
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELIZATION}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function verifyPassword(password, encodedHash) {
  const parts = typeof encodedHash === "string" ? encodedHash.split("$") : [];
  const validFormat = parts.length === 6 && parts[0] === "scrypt" &&
    Number(parts[1]) === COST && Number(parts[2]) === BLOCK_SIZE &&
    Number(parts[3]) === PARALLELIZATION;
  const salt = validFormat ? Buffer.from(parts[4], "base64url") : DUMMY_SALT;
  const expected = validFormat ? Buffer.from(parts[5], "base64url") : DUMMY_HASH;
  if (!validFormat || salt.length !== 16 || expected.length !== KEY_LENGTH) {
    await scrypt(password, DUMMY_SALT, KEY_LENGTH, {
      N: COST, r: BLOCK_SIZE, p: PARALLELIZATION, maxmem: MAX_MEMORY
    });
    return false;
  }
  const actual = await scrypt(password, salt, KEY_LENGTH, {
    N: COST, r: BLOCK_SIZE, p: PARALLELIZATION, maxmem: MAX_MEMORY
  });
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, validatePassword, validateUsername, verifyPassword };
