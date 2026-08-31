import { challengeFromClientData, challengeFromResponse, safeEqual } from './webauthn.js';

let pass = 0, fail = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const clientData = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

console.log('\nreading the challenge back out of a ceremony response');
check('plain challenge',
  challengeFromClientData(clientData({ type: 'webauthn.get', challenge: 'abc123', origin: 'https://x' })), 'abc123');
check('nested in a full response body',
  challengeFromResponse({ id: 'cred', response: { clientDataJSON: clientData({ challenge: 'deadbeef' }) } }), 'deadbeef');
check('missing clientDataJSON', challengeFromResponse({ id: 'cred', response: {} }), null);
check('missing response', challengeFromResponse({ id: 'cred' }), null);
check('null response', challengeFromResponse(null), null);
check('not an object', challengeFromResponse('nope'), null);
check('clientDataJSON not a string', challengeFromClientData(42), null);
check('empty clientDataJSON', challengeFromClientData(''), null);
check('not valid base64url JSON', challengeFromClientData('!!!not-json!!!'), null);
check('JSON without a challenge', challengeFromClientData(clientData({ type: 'webauthn.get' })), null);
check('challenge not a string', challengeFromClientData(clientData({ challenge: 7 })), null);
check('empty challenge', challengeFromClientData(clientData({ challenge: '' })), null);
check('JSON that is an array', challengeFromClientData(clientData(['a'])), null);

console.log('\nconstant-time compare');
check('equal strings match', safeEqual('correct-horse', 'correct-horse'), true);
check('different strings do not', safeEqual('correct-horse', 'battery-staple'), false);
check('a length mismatch does not throw', safeEqual('short', 'considerably-longer'), false);
check('empty vs empty', safeEqual('', ''), true);
check('empty vs non-empty', safeEqual('', 'x'), false);
check('a prefix is not a match', safeEqual('secret', 'secretsauce'), false);
check('unicode compares by bytes', safeEqual('café', 'café'), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
