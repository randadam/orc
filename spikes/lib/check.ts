/** The pass conditions of one spike: each is printed as it is checked, and failures are kept. */
export class Checks {
  readonly failed: string[] = [];

  /** Record and print one condition. Returns what it was given, so it can be used inline. */
  ok(name: string, pass: boolean): boolean {
    if (!pass) this.failed.push(name);
    console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}`);
    return pass;
  }

  get passed(): boolean {
    return this.failed.length === 0;
  }
}
