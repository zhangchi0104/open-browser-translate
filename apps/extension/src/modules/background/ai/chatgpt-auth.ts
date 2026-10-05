// Sign in with ChatGPT for open-source, locally hosted apps.
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
// Pure protocol helpers; browser wiring lives in chatgpt-session.ts.

import type { ChatGPTModel } from "../../shared/protocol";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_API_URL = "https://api.openai.com/v1";
const AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME = "Open Browser Translate";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
// Loopback callback required by OpenAI. Nothing listens here: the extension reads the
// code from the tab's URL before the page loads, so the port only has to stay stable.
export const CHATGPT_REDIRECT_URI = "http://127.0.0.1:45173/callback";

export interface ChatGPTAccount {
  email: string;
  subject: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
}
export interface ChatGPTAuth {
  /** `ext_agent_host_id`, stable for this browser profile. */
  hostId: string;
  /** Issued `oaiapp_...` client ID, kept across sign-outs so returning users skip registration. */
  clientId?: string;
  account?: ChatGPTAccount;
}
export interface SignInAttempt {
  state: string;
  nonce: string;
  verifier: string;
  /** Client ID sent in the authorization request; `dynamic_agent_client` on first registration. */
  clientId: string;
  createdAt: number;
}
export class ChatGPTAuthError extends Error {
  constructor(readonly reason: "denied" | "no-plan" | "invalid" | "expired", message: string = reason) {
    super(message);
  }
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeBase64url(value: string) {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function random() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function newHostId() {
  return `urn:uuid:${crypto.randomUUID()}`;
}

export async function createSignIn(auth: ChatGPTAuth): Promise<{ url: string; attempt: SignInAttempt }> {
  const attempt: SignInAttempt = { state: random(), nonce: random(), verifier: random(), clientId: auth.clientId ?? DYNAMIC_CLIENT_ID, createdAt: Date.now() };
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(attempt.verifier))));
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: attempt.clientId,
    ...(auth.clientId ? {} : { agent_name_hint: AGENT_NAME }),
    ext_agent_host_id: auth.hostId,
    response_type: "code",
    redirect_uri: CHATGPT_REDIRECT_URI,
    scope: SCOPES,
    resource: CHATGPT_API_URL,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
    ...(auth.account ? { id_token_hint: auth.account.idToken } : {}),
  }).toString();
  return { url: url.toString(), attempt };
}

export function isCallbackUrl(url: string) {
  return url.startsWith(`${CHATGPT_REDIRECT_URI}?`);
}

/** Validates the callback and returns the code with the client ID to exchange it under. */
export function parseCallback(url: string, attempt: SignInAttempt) {
  const params = new URL(url).searchParams;
  if (params.get("state") !== attempt.state) throw new ChatGPTAuthError("invalid", "state mismatch");
  const error = params.get("error");
  if (error) throw new ChatGPTAuthError("denied", [error, params.get("error_description")].filter(Boolean).join(": "));
  const code = params.get("code");
  if (!code) throw new ChatGPTAuthError("invalid", "missing code");
  const clientId = attempt.clientId === DYNAMIC_CLIENT_ID ? params.get("client_id") : attempt.clientId;
  if (!clientId || clientId === DYNAMIC_CLIENT_ID) throw new ChatGPTAuthError("invalid", "missing issued client_id");
  return { code, clientId };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}
async function requestTokens(fetcher: typeof fetch, form: Record<string, string>) {
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, resource: CHATGPT_API_URL }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let body: { error?: unknown; error_description?: unknown } = {};
    try { body = JSON.parse(text); } catch {}
    // Keep the server's own explanation: it is the only clue when a live sign-in fails.
    const detail = typeof body.error === "string"
      ? [body.error, body.error_description].filter((part) => typeof part === "string" && part).join(": ")
      : text.slice(0, 300);
    throw new ChatGPTAuthError(body.error === "invalid_grant" ? "expired" : "invalid", `token endpoint returned ${response.status}${detail ? ` (${detail})` : ""}`);
  }
  return await response.json() as TokenResponse;
}

let jwks: Promise<JsonWebKey[]> | undefined;
async function signingKeys(fetcher: typeof fetch) {
  jwks ??= (async () => {
    const config = await (await fetcher(`${CHATGPT_ISSUER}/.well-known/openid-configuration`)).json() as { jwks_uri: string };
    return ((await (await fetcher(config.jwks_uri)).json()) as { keys: JsonWebKey[] }).keys;
  })().catch((error) => { jwks = undefined; throw error; });
  return jwks;
}

/** Verifies an ID token's signature and claims, returning its payload. */
export async function verifyIdToken(idToken: string, expected: { clientId: string; nonce?: string }, fetcher: typeof fetch = fetch) {
  const [header, payload, signature] = idToken.split(".");
  if (!header || !payload || !signature) throw new ChatGPTAuthError("invalid", "malformed id_token");
  const { alg, kid } = JSON.parse(new TextDecoder().decode(decodeBase64url(header)));
  if (alg !== "RS256") throw new ChatGPTAuthError("invalid", `unsupported id_token alg ${alg}`);
  const jwk = (await signingKeys(fetcher)).find((key) => (key as { kid?: string }).kid === kid);
  if (!jwk) throw new ChatGPTAuthError("invalid", "unknown id_token key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64url(signature), new TextEncoder().encode(`${header}.${payload}`));
  if (!valid) throw new ChatGPTAuthError("invalid", "bad id_token signature");
  const claims = JSON.parse(new TextDecoder().decode(decodeBase64url(payload))) as { iss: string; aud: string | string[]; exp: number; sub: string; nonce?: string; email?: string };
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== CHATGPT_ISSUER || !audience.includes(expected.clientId) || claims.exp * 1000 <= Date.now() || !claims.sub
    || (expected.nonce !== undefined && claims.nonce !== expected.nonce)) {
    throw new ChatGPTAuthError("invalid", "id_token claims rejected");
  }
  return claims;
}

function toAccount(tokens: TokenResponse, claims: { sub: string; email?: string }, previous?: ChatGPTAccount): ChatGPTAccount {
  const scopes = tokens.scope?.split(" ").filter(Boolean) ?? previous?.scopes ?? [];
  if (!scopes.includes(PLAN_SCOPE)) throw new ChatGPTAuthError("no-plan", "ChatGPT plan usage was not granted");
  return {
    email: claims.email ?? previous?.email ?? "",
    subject: claims.sub,
    idToken: tokens.id_token ?? previous!.idToken,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous!.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    scopes,
  };
}

export async function completeSignIn(auth: ChatGPTAuth, attempt: SignInAttempt, callbackUrl: string, fetcher: typeof fetch = fetch): Promise<ChatGPTAuth> {
  const { code, clientId } = parseCallback(callbackUrl, attempt);
  const tokens = await requestTokens(fetcher, { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CHATGPT_REDIRECT_URI, code_verifier: attempt.verifier });
  if (!tokens.id_token || !tokens.refresh_token) throw new ChatGPTAuthError("invalid", "token response is missing id_token or refresh_token");
  const claims = await verifyIdToken(tokens.id_token, { clientId, nonce: attempt.nonce }, fetcher);
  return { ...auth, clientId, account: toAccount(tokens, claims) };
}

export async function refreshAccount(auth: ChatGPTAuth, fetcher: typeof fetch = fetch): Promise<ChatGPTAuth> {
  const account = auth.account!;
  const tokens = await requestTokens(fetcher, { grant_type: "refresh_token", client_id: auth.clientId!, refresh_token: account.refreshToken });
  let claims: { sub: string; email?: string } = { sub: account.subject, email: account.email };
  if (tokens.id_token) {
    claims = await verifyIdToken(tokens.id_token, { clientId: auth.clientId! }, fetcher);
    if (claims.sub !== account.subject) throw new ChatGPTAuthError("invalid", "refreshed token belongs to another account");
  }
  return { ...auth, account: toAccount(tokens, claims, account) };
}

export async function listModels(accessToken: string, fetcher: typeof fetch = fetch): Promise<ChatGPTModel[]> {
  const response = await fetcher(`${CHATGPT_API_URL}/models`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`models request failed with ${response.status}: ${(await response.text().catch(() => "")).slice(0, 500)}`);
  // https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
  const body = await response.json() as { models?: { slug?: string; display_name?: string; visibility?: string }[] };
  return (body.models ?? []).flatMap(({ slug, display_name, visibility }) =>
    visibility === "list" && slug ? [{ slug, displayName: display_name ?? slug }] : []);
}
