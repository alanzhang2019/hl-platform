const { execFileSync } = require('child_process');
const files = process.argv.slice(2);
let ok = true;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
    console.log('OK: ' + f);
  } catch (e) {
    ok = false;
    console.log('FAIL: ' + f);
  }
}
process.exit(ok ? 0 : 1);
