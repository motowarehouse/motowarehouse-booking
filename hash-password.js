// Run this once to generate your admin password hash:
// node hash-password.js YourPasswordHere
const bcrypt = require('bcryptjs');
const password = process.argv[2];
if (!password) { console.log('Usage: node hash-password.js <password>'); process.exit(1); }
const hash = bcrypt.hashSync(password, 10);
console.log('\nAdd this to your .env file:');
console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
