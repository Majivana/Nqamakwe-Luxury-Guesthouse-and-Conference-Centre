require("dotenv").config();
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { createDatabase } = require("./db");
const { hashPassword, validatePassword, validateUsername } = require("./password-auth");

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Run this command in an interactive terminal.");
  }
  const db = createDatabase(process.env.DATABASE_PATH || "server/data/guesthouse.sqlite");
  const prompt = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    if (db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1").get()) {
      throw new Error("An active administrator already exists. Ask an administrator to create or promote your account.");
    }
    const name = (await prompt.question("Administrator name: ")).trim();
    const email = (await prompt.question("Administrator email: ")).trim().toLowerCase();
    const username = validateUsername(await prompt.question("Username: "));
    if (!name || name.length > 120) throw new Error("Name is required and must be at most 120 characters.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error("Enter a valid email address.");
    if (!username) throw new Error("Username must be 3–32 letters, numbers, dots, underscores, or hyphens.");
    const password = await prompt.question("Password (6 characters minimum): ", { hideEchoBack: true, mask: "*" });
    const confirmation = await prompt.question("Confirm password: ", { hideEchoBack: true, mask: "*" });
    if (!validatePassword(password)) throw new Error("Password must be between 6 and 128 characters.");
    if (password !== confirmation) throw new Error("Passwords do not match.");
    const existing = db.prepare(`
      SELECT id FROM users
      WHERE lower(email) IN (?, ?) OR username COLLATE NOCASE IN (?, ?)
      LIMIT 1
    `).get(email, username, email, username);
    if (existing) throw new Error("An account already uses those details.");
    const passwordHash = await hashPassword(password);
    db.transaction(() => {
      db.prepare(`
        INSERT INTO users (name, email, username, password_hash, role, staff_role)
        VALUES (?, ?, ?, ?, 'admin', 'director')
      `).run(name, email, username, passwordHash);
    })();
    console.log("Administrator account created. You can now sign in at /login.html.");
  } finally {
    prompt.close();
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
