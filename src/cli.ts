import { resolve } from "node:path";
import { runClinicalGenomicsWorkbench } from "./clinical-genomics.js";

const exampleDir = resolve(process.argv[2] ?? "examples/clinical-genomics");
const caseId = process.argv[3] ?? "CASE-RD-001";

const out = await runClinicalGenomicsWorkbench({ exampleDir, caseId });

console.log(`case: ${out.packet.caseId}`);
console.log(`packet: ${out.packetUri}`);
console.log(`store: ${out.storePath}`);
console.log("summary:");
console.table([out.packet.summary]);
console.log("review queue:");
console.table(out.packet.summary.reviewQueue);
