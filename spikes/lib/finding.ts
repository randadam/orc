/** One spike's result, in the shape `FINDINGS.md` records. */
export interface Finding {
  spike: string;
  pass: boolean;
  line: string;
  script: string;
}

/** Print a finding and exit 0 on pass, 1 on fail. Every spike ends here. */
export function report(finding: Finding): never {
  console.log(`\n## ${finding.spike}`);
  console.log(finding.line);
  console.log(`script: ${finding.script}   pi: 0.86.1   date: ${new Date().toISOString().slice(0, 10)}`);
  process.exit(finding.pass ? 0 : 1);
}
