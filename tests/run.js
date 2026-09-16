// Minimal zero-dependency test runner.
//
// Every test module exports `export const tests = [{ name, fn }]`.  The list of
// modules is explicit (not a directory scan) to keep this file trivial.
// Run with: node tests/run.js

const MODULES = [
  "./standings.test.js",
  "./scenarios.test.js",
  "./picks.test.js",
  "./perspective.test.js",
  "./data.test.js",
];

async function main() {
  let pass = 0;
  let fail = 0;
  const failures = [];
  const started = Date.now();

  for (const spec of MODULES) {
    let mod;
    try {
      mod = await import(spec);
    } catch (err) {
      fail++;
      failures.push([spec, err]);
      console.log(`FAIL - ${spec} (could not be imported)`);
      console.log(String(err && err.stack ? err.stack : err));
      continue;
    }
    for (const t of mod.tests || []) {
      const t0 = Date.now();
      try {
        await t.fn();
        const ms = Date.now() - t0;
        pass++;
        console.log(`ok - ${t.name}${ms >= 50 ? ` (${ms} ms)` : ""}`);
      } catch (err) {
        fail++;
        failures.push([t.name, err]);
        console.log(`FAIL - ${t.name}`);
        console.log(String(err && err.stack ? err.stack : err));
      }
    }
  }

  const ms = Date.now() - started;
  console.log("");
  console.log(`${pass} passed, ${fail} failed, ${pass + fail} total (${ms} ms)`);
  if (fail > 0) {
    console.log("");
    console.log("Failed tests:");
    for (const [name] of failures) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
}

main();
