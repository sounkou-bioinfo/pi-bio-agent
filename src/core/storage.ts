import { join, resolve } from "node:path";
import type { ContentAddress } from "./resources.js";

export interface BioProjectLayout {
  root: string;
  skillsDir: string;
  studyNotesDir: string;
  resourcesDir: string;
  casDir: string;
  artifactsDir: string;
  duckdbPath: string;
}

export function bioProjectLayout(cwd: string, root = ".pi/bio-agent"): BioProjectLayout {
  const base = resolve(cwd, root);
  return {
    root: base,
    skillsDir: join(base, "skills"),
    studyNotesDir: join(base, "study-notes"),
    resourcesDir: join(base, "resources"),
    casDir: join(base, "cas"),
    artifactsDir: join(base, "artifacts"),
    duckdbPath: join(base, "bio.duckdb"),
  };
}

export function casPathForAddress(layout: Pick<BioProjectLayout, "casDir">, address: ContentAddress): string {
  const errors = validateContentAddress(address);
  if (errors.length) throw new Error(`invalid content address: ${errors.join("; ")}`);
  return join(layout.casDir, address.algorithm, address.digest.toLowerCase());
}

export function validateContentAddress(address: ContentAddress): string[] {
  const errors: string[] = [];
  if (address.algorithm !== "sha256") errors.push("algorithm must be sha256"); // sha256-only: the store/GC back nothing else
  if (typeof address.digest !== "string" || !/^[a-fA-F0-9]+$/.test(address.digest)) errors.push("digest must be hexadecimal");
  if (address.algorithm === "sha256" && address.digest?.length !== 64) errors.push("sha256 digest must be 64 hex chars");
  if (address.sizeBytes !== undefined && address.sizeBytes < 0) errors.push("sizeBytes cannot be negative");
  return errors;
}
