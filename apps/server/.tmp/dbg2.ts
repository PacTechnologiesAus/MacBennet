import { createSign, generateKeyPairSync } from 'node:crypto';
import { config } from '../src/config.js';
import { verifyTeamsRequest, __setKeyCacheForTests, EXPECTED_ISSUERS } from '../src/services/teams/verify.js';

console.log('appId =', config.teams.appId);

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = pair.publicKey.export({ format: 'jwk' }) as { n: string; e: string };
__setKeyCacheForTests(new Map([['k1', { kid: 'k1', kty: 'RSA', n: jwk.n, e: jwk.e }]]));

const b64 = (v: object | string) =>
  Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const now = Math.floor(Date.now() / 1000);
const header = { typ: 'JWT', alg: 'RS256', kid: 'k1' };
const claims = { aud: config.teams.appId, iss: EXPECTED_ISSUERS[0], exp: now + 600, nbf: now - 60, serviceUrl: 'https://smba.trafficmanager.net/au/' };
const input = `${b64(header)}.${b64(claims)}`;
const signer = createSign('RSA-SHA256');
signer.update(input);
signer.end();
const sig = signer.sign(pair.privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const result = await verifyTeamsRequest({
  authorizationHeader: `Bearer ${input}.${sig}`,
  activity: { type: 'message', serviceUrl: 'https://smba.trafficmanager.net/au/' } as never,
});
console.log(JSON.stringify(result, null, 2));
