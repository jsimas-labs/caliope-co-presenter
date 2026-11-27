// test/language.mjs — the talk language (LANGUAGE) sets her speech, the fixed phrases and the transcription.
//   npm test
import assert from 'node:assert/strict';

const load = async (env) => {
  for (const k of ['LANGUAGE', 'REFUSAL', 'RECUSA']) delete process.env[k];
  Object.assign(process.env, env);
  return import(`../agent.mjs?${JSON.stringify(env)}`);
};

const pt = await load({});
assert.equal(pt.LANGUAGE, 'pt-BR');
assert.equal(pt.REFUSAL, 'Isso eu não posso. O sim é seu.');
assert.match(pt.INSTRUCTIONS, /Speak Brazilian Portuguese/);
assert.match(pt.INSTRUCTIONS, /never European Portuguese/);
console.log('✓ default pt-BR: Brazilian Portuguese, Brazilian accent, Portuguese refusal');

const en = await load({ LANGUAGE: 'en-US' });
assert.equal(en.LANG, 'en');
assert.equal(en.REFUSAL, "I can't do that. The yes is yours.");
assert.equal(en.PHRASES.listening, '{name} listening');
assert.match(en.INSTRUCTIONS, /Speak English\. If Jonathan talks to you in another language, answer in that language/);
assert.doesNotMatch(en.INSTRUCTIONS, /European Portuguese/);
console.log('✓ LANGUAGE=en-US: English speech, English refusal and badge');

const fr = await load({ LANGUAGE: 'fr-FR' });
assert.match(fr.INSTRUCTIONS, /Speak French/);
assert.equal(fr.REFUSAL, en.REFUSAL);   // no fixed phrases for French yet: English
console.log('✓ LANGUAGE=fr-FR: French speech, fixed phrases fall back to English');

const old = await load({ RECUSA: 'Não.' });
assert.equal(old.REFUSAL, 'Não.');
const custom = await load({ LANGUAGE: 'en', REFUSAL: 'Your call.' });
assert.equal(custom.REFUSAL, 'Your call.');
assert.match(custom.INSTRUCTIONS, /answer exactly: "Your call\."/);
console.log('✓ REFUSAL (and the old RECUSA) replace the refusal');
console.log('\nAll good.');
