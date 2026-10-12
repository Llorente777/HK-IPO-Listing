import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Use the exact same verifier as the future website writer, in an isolated run.
// Never log, persist or pass the short-lived token as a command-line argument.
const source=readFileSync(new URL('../../lib/github-update-identity.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {updateTrust,verifyUpdateIdentity}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const address=process.env.ACTIONS_ID_TOKEN_REQUEST_URL, bearer=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
if(!address||!bearer)throw Error('GitHub OIDC request environment is unavailable');
const url=new URL(address);
if(url.protocol!=='https:'||!url.hostname.endsWith('.actions.githubusercontent.com'))throw Error('Unexpected GitHub OIDC endpoint');
url.searchParams.set('audience',updateTrust.audience);
const response=await fetch(url,{headers:{Authorization:`Bearer ${bearer}`},redirect:'error',signal:AbortSignal.timeout(15000)});
if(!response.ok)throw Error(`GitHub identity request failed: HTTP ${response.status}`);
const {value}=await response.json();
let identity;
try {
  identity=await verifyUpdateIdentity(value);
} catch {
  // Only public routing metadata, never the token, signature, actor or request bearer.
  const decoded=JSON.parse(Buffer.from(value.split('.')[1],'base64url'));
  const keys=['sub','event_name','workflow_ref','job_workflow_ref'];
  console.error(JSON.stringify({identity_verified:false,routing:Object.fromEntries(keys.map(k=>[k,decoded[k]??null]))}));
  console.error('Cloud identity rejected; no website write was attempted.');
  process.exit(1);
}
if(identity.runId!==process.env.GITHUB_RUN_ID || identity.commit!==process.env.GITHUB_SHA)throw Error('Runner identity does not match this job');
console.log(JSON.stringify({identity_verified:true,repository:updateTrust.repository,run_id:identity.runId,source_commit:identity.commit}));
