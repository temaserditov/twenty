// Local verification only. Tokens remain in process memory; no browser storage or disk files.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Twenty } from '../src/twenty.mjs';
import { startReceiver } from '../src/server.mjs';

const origin = 'http://localhost:3033';
if (!process.env.CRM_LOCAL_ADMIN_PASSWORD) throw new Error('local_password_required');
async function graphql(query, variables = {}, token) {
  const response = await fetch(`${origin}/metadata`, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: {'content-type': 'application/json', origin, ...(token ? {authorization: `Bearer ${token}`} : {})},
    body: JSON.stringify({query, variables}),
  });
  const result = await response.json();
  if (result.errors) throw new Error('local_auth_failed');
  return result.data;
}
const email = 'crm-local@serditov.example';
const checked = await graphql('query($email:String!){checkUserExists(email:$email){exists availableWorkspacesCount}}', {email});
if (checked.checkUserExists.availableWorkspacesCount === 0) {
  const operation = checked.checkUserExists.exists ? 'signIn' : 'signUp';
  const signed = await graphql(`mutation($email:String!,$password:String!){${operation}(email:$email,password:$password){tokens{accessOrWorkspaceAgnosticToken{token}}}}`, {
    email, password: process.env.CRM_LOCAL_ADMIN_PASSWORD,
  });
  await graphql('mutation{signUpInNewWorkspace(input:{displayName:"Serditov CRM — локальная проверка"}){workspace{id}}}', {}, signed[operation].tokens.accessOrWorkspaceAgnosticToken.token);
}
async function authenticate() {
const login = await graphql('mutation($email:String!,$password:String!,$origin:String!){getLoginTokenFromCredentials(email:$email,password:$password,origin:$origin){loginToken{token}}}', {
  email, password: process.env.CRM_LOCAL_ADMIN_PASSWORD, origin,
});
const auth = await graphql('mutation($loginToken:String!,$origin:String!){getAuthTokensFromLoginToken(loginToken:$loginToken,origin:$origin){tokens{accessOrWorkspaceAgnosticToken{token expiresAt}}}}', {
  loginToken: login.getLoginTokenFromCredentials.loginToken.token, origin,
});
return auth.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken;
}
let session = await authenticate();
const token = session.token;
const current = await graphql('{currentWorkspace{id activationStatus}}', {}, token);
if (current.currentWorkspace.activationStatus === 'PENDING_CREATION') {
  await graphql('mutation{activateWorkspace(data:{}){id activationStatus}}', {}, token);
}
if (process.argv[2] === 'server') {
  startReceiver(new Twenty(origin, async () => {
    if (Date.parse(session.expiresAt) - Date.now() < 60_000) session = await authenticate();
    return session.token;
  }));
} else {
const entry = {bootstrap: '../src/bootstrap.mjs', smoke: './smoke.mjs'}[process.argv[2]];
if (!entry) throw new Error('usage: local-session.mjs bootstrap|smoke|server');
const env = {...process.env, TWENTY_URL: origin, TWENTY_TOKEN: token};
delete env.CRM_LOCAL_ADMIN_PASSWORD;
const child = spawn(process.execPath, [fileURLToPath(new URL(entry, import.meta.url))], {env, stdio: 'inherit'});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
}
