// Unit tests for the connector's pure helpers (name matching, prefixes, phone lookup).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'connector', 'Code.gs'), 'utf8'), ctx);

assert.strictEqual(ctx.normalizeName_('יוֹסִי  כֹּהֵן'), ctx.normalizeName_('יוסי כהן'));
assert.strictEqual(ctx.normalizeName_('Dana  Levi'), 'dana levi');
assert.strictEqual(ctx.stripPrefix_('✅ ❌ יוסי כהן'), 'יוסי כהן');
assert.strictEqual(ctx.findPhone_('טל: 050-123-4567 תודה'), '050-123-4567');
assert.strictEqual(ctx.findPhone_('+972 52 123 4567'), '+972 52 123 4567');
assert.strictEqual(ctx.findPhone_('no phone here'), '');
console.log('✓ connector helpers\n\nALL CONNECTOR TESTS PASSED');
