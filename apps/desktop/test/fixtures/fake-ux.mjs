/**
 * Fixture ux kernel for the ux-server unit tests. Invoked exactly like the real
 * opencli-ux ux.mjs (`node fake-ux.mjs render --spec <file> --keep …`), it reads
 * the spec file and follows its `mode` directive so tests can drive
 * announce / crash / hang behavior deterministically.
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);

// `pool` = the pooled-kernel probe (docs/ux-pool-protocol.md). This fixture has
// no pool support, so it does what an older ux.mjs does on an unknown command:
// error out WITHOUT announcing `{"pooled":true}`. The ux-server probe treats
// that clean exit as "not pool-capable" and falls back to per-page servers —
// which is exactly the path these suites exercise.
if (args[0] === 'pool') {
  process.stderr.write('fake-ux: no pool mode\n');
  process.exit(2);
}

const spec = JSON.parse(readFileSync(args[args.indexOf('--spec') + 1], 'utf8'));

const stayAlive = () => setInterval(() => {}, 1000);

if (spec.mode === 'banner-then-announce') {
  // regression: a non-JSON banner line before the announce must not wedge the scanner.
  process.stdout.write('fake-ux kernel warming up (banner line, not JSON)\n');
  process.stdout.write(`${JSON.stringify({ rendered: true, url: spec.url, keep: true })}\n`);
  stayAlive();
} else if (spec.mode === 'exit-with-stderr') {
  process.stderr.write('boom: kernel exploded while parsing the spec\n');
  process.exit(3);
} else if (spec.mode === 'never-announce') {
  process.stdout.write('still warming up\n');
  stayAlive();
} else {
  process.stderr.write(`fake-ux: unknown mode ${String(spec.mode)}\n`);
  process.exit(2);
}
