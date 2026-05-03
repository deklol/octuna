// One-time setup: prompt for admin user + password, hash with scrypt, write to config.json.
// Re-run any time to rotate credentials.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function ask(rl, q, hide) {
  return new Promise(resolve => {
    if (!hide) return rl.question(q, resolve);
    // Hide input (no echo) — write a space then mask
    process.stdout.write(q);
    const stdin = process.stdin;
    let buf = '';
    const onData = ch => {
      ch = String(ch);
      if (ch === '\n' || ch === '\r' || ch === '') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write('\n');
        return resolve(buf);
      }
      if (ch === '') process.exit(1);            // Ctrl+C
      if (ch === '' || ch === '\b') { buf = buf.slice(0, -1); return; }
      buf += ch;
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nOctuna — admin setup\n');

  const defaultUser = config.adminUser || 'admin';
  let user = (await ask(rl, `Admin username [${defaultUser}]: `)).trim() || defaultUser;

  let p1, p2;
  for (;;) {
    p1 = await ask(rl, 'Admin password (min 10 chars, blank to auto-generate): ', true);
    if (!p1) {
      p1 = crypto.randomBytes(15).toString('base64url');
      console.log(`Generated password: ${p1}\n(SAVE THIS — it will not be shown again)`);
      break;
    }
    if (p1.length < 10) { console.log('Too short.'); continue; }
    p2 = await ask(rl, 'Confirm password: ', true);
    if (p1 !== p2) { console.log('Mismatch, try again.'); continue; }
    break;
  }
  rl.close();

  const { salt, hash } = hashPassword(p1);
  config.adminUser = user;
  config.adminSalt = salt;
  config.adminHash = hash;
  if (!config.sessionSecret) config.sessionSecret = crypto.randomBytes(32).toString('base64');

  // Wipe any plaintext password leftover from older versions
  delete config.adminPass;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`\nSaved. Admin user: ${user}`);
  console.log('Start the server with: npm start');
})();
