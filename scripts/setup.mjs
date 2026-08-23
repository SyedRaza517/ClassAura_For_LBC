// One-time setup: create .env files, generate Prisma client, create + seed the database.
// Run AFTER `npm install`, with:  npm run setup
import { execSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function ensureEnv(folder) {
  const ex = join(root, folder, ".env.example");
  const en = join(root, folder, ".env");
  if (existsSync(ex) && !existsSync(en)) { copyFileSync(ex, en); console.log("created " + folder + "/.env"); }
}
function run(cmd, cwd) { console.log("\n> " + cmd); execSync(cmd, { cwd, stdio: "inherit" }); }

// Resolve the locally-installed Prisma CLI. We deliberately avoid `npx prisma`,
// which downloads the *latest* Prisma (currently v7) when the local bin isn't on
// its path — v7 rejects this project's schema (`url` in the datasource block).
// The bin may live in server/node_modules (workspace) or root node_modules (hoisted).
function prismaBin(server) {
  const exe = process.platform === "win32" ? "prisma.cmd" : "prisma";
  const candidates = [join(server, "node_modules", ".bin", exe), join(root, "node_modules", ".bin", exe)];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Local Prisma CLI not found — run `npm install` first.");
  return JSON.stringify(found); // quote in case the path contains spaces
}

console.log("Setting up EdTech — Staff Hub …");
ensureEnv("server");
ensureEnv("client");

const server = join(root, "server");
const prisma = prismaBin(server);
run(`${prisma} generate`, server);
// Applies every migration in prisma/migrations in order. Replaces `db push`, which
// reconciled the database to schema.prisma with no history and no review step — it
// could drop a column (and its data) silently. See prisma/migrations/README.md.
run(`${prisma} migrate deploy`, server);
// Loads the admin account + sample data. The seed REFUSES to run without SEED_PASSWORD
// (12+ characters) and never hard-codes a password — a seeded account that reaches a
// real database is a real way in — so set it in the environment before running this.
run("node prisma/seed.js", server);

console.log("\n✅ Setup complete. Start everything with:  npm run dev");
// This used to print "admin@edtech.co.uk / password123". That password has not existed
// since the seed started reading SEED_PASSWORD, so the one instruction a first-time user
// actually follows was the one thing on screen that was wrong: they typed it, got
// "invalid credentials", and had no way to tell a broken setup from a wrong password.
console.log("   Then open http://localhost:5173 and sign in as  admin@edtech.co.uk");
console.log("   The password is the SEED_PASSWORD you set before seeding — it is never printed.");
