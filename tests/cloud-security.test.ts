import {beforeAll,describe,expect,it} from 'vitest';
import {checkUpdateClaims,createUpdateIdentityVerifier,updateTrust} from '../lib/github-update-identity';

const now=1802340000;
const claims={iss:updateTrust.issuer,aud:updateTrust.audience,repository:updateTrust.repository,
  repository_id:updateTrust.repositoryId,repository_owner_id:updateTrust.ownerId,ref:updateTrust.ref,
  ref_type:'branch',workflow_ref:updateTrust.workflow,repository_visibility:'public',runner_environment:'github-hosted',
  sub:`repo:Llorente777@${updateTrust.ownerId}/HK-IPO-Listing@${updateTrust.repositoryId}:ref:${updateTrust.ref}`,
  event_name:'workflow_dispatch',iat:now-10,nbf:now-10,exp:now+290,run_id:'123',run_attempt:'1',sha:'a'.repeat(40)};
describe('cloud writer trust boundary',()=>{
  it('accepts fixed main workflow with immutable repository identity',()=>{
    expect(checkUpdateClaims(claims,now).runId).toBe('123');
    // Actual GitHub-hosted runs also include job_workflow_ref for this same job.
    expect(checkUpdateClaims({...claims,job_workflow_ref:updateTrust.workflow},now).runId).toBe('123');
  });
  it.each([
    ['repository_id','999'],['repository_owner_id','999'],['repository','other/repo'],
    ['workflow_ref','Llorente777/HK-IPO-Listing/.github/workflows/other.yml@refs/heads/main'],
    ['ref','refs/heads/other'],['event_name','pull_request'],['event_name','pull_request_target'],
    ['event_name','dynamic'],['sub','repo:other/repo:ref:refs/heads/main'],
    ['aud','https://other.site'],['iss','https://fake.example'],['exp',now],['iat',now+50],
    ['nbf',now+50],['exp',now+3600],['run_id','../escape'],['sha','not-a-sha'],
    ['job_workflow_ref','untrusted/repo/reusable.yml@main'],
  ])('rejects wrong claim %s', (key,value)=>{
    expect(()=>checkUpdateClaims({...claims,[key]:value},now)).toThrow();
  });
  it('rejects nonnumeric expiry and inherited fork identities',()=>{
    expect(()=>checkUpdateClaims({...claims,exp:String(now+300)},now)).toThrow();
    expect(()=>checkUpdateClaims({...claims,sub:`repo:${updateTrust.repository}:pull_request`},now)).toThrow();
  });
});

describe('cloud JWT cryptographic verification',()=>{
  let pair:CryptoKeyPair, jwk:JsonWebKey & {kid:string};
  const base64=(v:Uint8Array)=>Buffer.from(v).toString('base64url');
  const encode=(v:unknown)=>base64(new TextEncoder().encode(JSON.stringify(v)));
  beforeAll(async()=>{
    pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
    jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'test-key',use:'sig',alg:'RS256'};
  });
  async function sign(header:Record<string,unknown>={alg:'RS256',typ:'JWT',kid:'test-key'}) {
    const input=encode(header)+'.'+encode(claims);
    return input+'.'+base64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(input))));
  }
  it('verifies signature before returning writer identity',async()=>{
    const verify=createUpdateIdentityVerifier(async()=>[jwk]);
    await expect(verify(await sign(),now)).resolves.toMatchObject({runId:'123',commit:'a'.repeat(40)});
  });
  it('rejects forged signature, unknown keys and supplied key URLs',async()=>{
    const token=await sign(), parts=token.split('.'), verify=createUpdateIdentityVerifier(async()=>[jwk]);
    parts[2]=base64(new Uint8Array(256));
    await expect(verify(parts.join('.'),now)).rejects.toThrow();
    await expect(createUpdateIdentityVerifier(async()=>[]) (token,now)).rejects.toThrow();
    await expect(verify(await sign({alg:'RS256',typ:'JWT',kid:'test-key',jku:'https://attacker.example/keys'}),now)).rejects.toThrow();
    await expect(verify(await sign({alg:'none',typ:'JWT',kid:'test-key'}),now)).rejects.toThrow();
  });
});
