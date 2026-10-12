/** Trust only this repository's fixed main-branch update workflow.
 * GitHub signs short-lived identities; no owner PAT is stored in the website.
 * This module does not itself expose or enable a public write endpoint.
 * Reference: https://docs.github.com/en/actions/reference/security/oidc
 */
export const updateTrust = Object.freeze({
  issuer: 'https://token.actions.githubusercontent.com',
  jwks: 'https://token.actions.githubusercontent.com/.well-known/jwks',
  audience: 'https://hk-ipo-a-to-h-monitor.jaydipsinhhuskaj.chatgpt.site',
  repository: 'Llorente777/HK-IPO-Listing',
  repositoryId: '1415243353', ownerId: '341337224',
  ref: 'refs/heads/main',
  workflow: 'Llorente777/HK-IPO-Listing/.github/workflows/weekly-update.yml@refs/heads/main',
});

type Claims = Record<string, unknown>;
type SigningKey = JsonWebKey & {kid?: string};
export type UpdateIdentity = {runId: string; runAttempt: string; commit: string; expiresAt: number};
const reject = (): never => {throw new Error('Untrusted cloud update identity');};
function decode(part: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return reject();
  const encoded = part.replace(/-/g, '+').replace(/_/g, '/');
  try { return Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')), c=>c.charCodeAt(0)); }
  catch { return reject(); }
}
function jsonPart(part: string): Claims {
  try {
    const result = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(decode(part)));
    if (!result || typeof result !== 'object' || Array.isArray(result)) return reject();
    return result;
  } catch { return reject(); }
}
export function checkUpdateClaims(claims: Claims, nowSeconds: number): UpdateIdentity {
  const t = updateTrust;
  for (const [key,value] of Object.entries({iss:t.issuer,aud:t.audience,repository:t.repository,
    repository_id:t.repositoryId,repository_owner_id:t.ownerId,ref:t.ref,ref_type:'branch',workflow_ref:t.workflow,
    repository_visibility:'public',runner_environment:'github-hosted'})) {
    if (claims[key] !== value) return reject();
  }
  const subjects = [
    `repo:${t.repository}:ref:${t.ref}`,
    `repo:Llorente777@${t.ownerId}/HK-IPO-Listing@${t.repositoryId}:ref:${t.ref}`,
  ];
  if (!subjects.includes(String(claims.sub)) || !['workflow_dispatch','schedule'].includes(String(claims.event_name))
    || claims.job_workflow_ref != null) return reject();
  const {iat,nbf,exp} = claims;
  if (![iat,nbf,exp,nowSeconds].every(v=>typeof v==='number' && Number.isFinite(v))) return reject();
  const issued=iat as number, notBefore=nbf as number, expires=exp as number;
  if (issued>nowSeconds+30 || notBefore>nowSeconds+30 || expires<=nowSeconds || expires<=issued
    || expires-issued>900 || nowSeconds-issued>900) return reject();
  if (typeof claims.run_id!=='string' || !/^[1-9]\d{0,19}$/.test(claims.run_id)
    || typeof claims.run_attempt!=='string' || !/^[1-9]\d{0,5}$/.test(claims.run_attempt)
    || typeof claims.sha!=='string' || !/^[a-f0-9]{40}$/.test(claims.sha)) return reject();
  return {runId:claims.run_id,runAttempt:claims.run_attempt,commit:claims.sha,expiresAt:expires};
}

/** Factory permits isolated test keys; production fetches only the fixed GitHub JWKS URL. */
export function createUpdateIdentityVerifier(fetchKeys: ()=>Promise<SigningKey[]>) {
  return async (token: string, nowSeconds=Math.floor(Date.now()/1000)): Promise<UpdateIdentity> => {
    if (typeof token!=='string' || token.length>20000) return reject();
    const parts=token.split('.'); if(parts.length!==3) return reject();
    const [headerPart,claimsPart,signaturePart]=parts, header=jsonPart(headerPart);
    if(header.alg!=='RS256' || header.typ!=='JWT' || typeof header.kid!=='string' || header.kid.length>200
      || header.crit!=null || header.jku!=null || header.jwk!=null || header.x5u!=null) return reject();
    const claims=jsonPart(claimsPart), identity=checkUpdateClaims(claims,nowSeconds);
    const matches=(await fetchKeys()).filter(k=>k.kid===header.kid && k.kty==='RSA' && k.use==='sig' && k.alg==='RS256');
    if(matches.length!==1 || !matches[0].n || decode(matches[0].n).length<256) return reject();
    const key=await crypto.subtle.importKey('jwk',matches[0],{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    const ok=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(signaturePart),new TextEncoder().encode(headerPart+'.'+claimsPart));
    if(!ok) return reject();
    return identity;
  };
}

let cachedKeys: {expires:number;keys:SigningKey[]}|undefined;
export const verifyUpdateIdentity=createUpdateIdentityVerifier(async()=>{
  if(cachedKeys && cachedKeys.expires>Date.now()) return cachedKeys.keys;
  const response=await fetch(updateTrust.jwks,{redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok) throw new Error('Cannot verify cloud signer');
  const text=await response.text(); if(text.length>100000) return reject();
  const payload=JSON.parse(text);
  if(!Array.isArray(payload.keys) || !payload.keys.length || payload.keys.length>20) return reject();
  cachedKeys={expires:Date.now()+60000,keys:payload.keys};
  return cachedKeys.keys;
});
