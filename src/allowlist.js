import { promises as fs } from "fs";
import path from "path";

const DEFAULT = {
  // whitelisted mints the AI may 'invest' into or 'distribute' in
  allowedTargets: [
    "So11111111111111111111111111111111111111112", // wSOL
  ],
  // tokens AI must never buy
  redZone: [
    // add known rugs / stables to block / etc.
  ],
  // wallets excluded from holder distribution (LPs, team, burn)
  distributionExcludes: [],
};

const FILE = path.resolve("config/allowed_targets.json");

export async function loadAllowedTargets() {
  try {
    const txt = await fs.readFile(FILE, "utf8");
    return JSON.parse(txt);
  } catch (e) {
    if (e.code === "ENOENT") {
      await fs.mkdir(path.dirname(FILE), { recursive: true });
      await fs.writeFile(FILE, JSON.stringify(DEFAULT, null, 2), "utf8");
      return DEFAULT;
    }
    throw e;
  }
}
