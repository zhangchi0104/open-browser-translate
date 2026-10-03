import { storage } from "wxt/utils/storage";
import { browser } from "wxt/browser";
import {
  ChatGPTAuthError, completeSignIn, createSignIn, isCallbackUrl, listModels, newHostId, refreshAccount,
  type ChatGPTAuth, type SignInAttempt,
} from "./chatgpt-auth";
import type { ChatGPTCredentials } from "./chatgpt";
import { debugLog } from "../debug-log";

// Tokens live apart from AISettings so saving the settings form never overwrites them.
export const chatgptAuth = storage.defineItem<ChatGPTAuth | null>("local:chatgptAuth", { fallback: null });
// Session storage keeps a pending sign-in alive if the service worker restarts mid-login.
const pendingSignIn = storage.defineItem<(SignInAttempt & { tabId: number }) | null>("session:chatgptSignIn", { fallback: null });
const SIGN_IN_TIMEOUT = 10 * 60_000;

export type SignInResult =
  | { status: "ok"; email: string }
  | { status: "failed"; reason: ChatGPTAuthError["reason"] | "cancelled"; detail?: string };
// The outcome is written to storage rather than returned on the options page's message: MV3 stops an
// idle service worker after ~30s, which closes any open message channel long before a person finishes
// signing in. `state` ties an outcome to the attempt the options page started.
export const chatgptSignInResult = storage.defineItem<(SignInResult & { state: string }) | null>("session:chatgptSignInResult", { fallback: null });
async function settle(state: string, result: SignInResult) {
  if (result.status === "ok") void debugLog.info("ChatGPT 登录成功");
  else if (result.reason !== "cancelled") void debugLog.error(`ChatGPT 登录失败：${result.reason}`, { detail: result.detail });
  await chatgptSignInResult.setValue({ ...result, state });
}

async function loadAuth(): Promise<ChatGPTAuth> {
  const saved = await chatgptAuth.getValue();
  if (saved) return saved;
  const created = { hostId: newHostId() };
  await chatgptAuth.setValue(created);
  return created;
}

/** Opens the sign-in tab and returns the attempt's `state`; the outcome arrives in `chatgptSignInResult`. */
export async function startChatGPTSignIn(): Promise<{ status: "started"; state: string }> {
  const previous = await pendingSignIn.getValue();
  if (previous) await settle(previous.state, { status: "failed", reason: "cancelled" });
  const { url, attempt } = await createSignIn(await loadAuth());
  const tab = await browser.tabs.create({ url });
  await pendingSignIn.setValue({ ...attempt, tabId: tab.id! });
  return { status: "started", state: attempt.state };
}

/** Registered at background startup: finishes sign-in when OpenAI redirects to the loopback callback. */
export async function handleChatGPTNavigation(tabId: number, url: string | undefined) {
  if (!url || !isCallbackUrl(url)) return;
  const attempt = await pendingSignIn.getValue();
  if (!attempt || attempt.tabId !== tabId) return;
  await pendingSignIn.setValue(null);
  await browser.tabs.remove(tabId).catch(() => {});
  if (Date.now() - attempt.createdAt > SIGN_IN_TIMEOUT) return settle(attempt.state, { status: "failed", reason: "expired" });
  try {
    const next = await completeSignIn(await loadAuth(), attempt, url);
    await chatgptAuth.setValue(next);
    await settle(attempt.state, { status: "ok", email: next.account!.email });
  } catch (error) {
    await settle(attempt.state, {
      status: "failed",
      reason: error instanceof ChatGPTAuthError ? error.reason : "invalid",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChatGPTTabClosed(tabId: number) {
  const attempt = await pendingSignIn.getValue();
  if (attempt?.tabId !== tabId) return;
  await pendingSignIn.setValue(null);
  await settle(attempt.state, { status: "failed", reason: "cancelled" });
}

export async function signOutChatGPT() {
  const auth = await chatgptAuth.getValue();
  if (auth) await chatgptAuth.setValue({ hostId: auth.hostId, clientId: auth.clientId });
}

let refreshing: Promise<string> | undefined;
async function accessToken(): Promise<string> {
  const auth = await chatgptAuth.getValue();
  if (!auth?.account) throw new ChatGPTAuthError("expired", "ChatGPT is signed out");
  if (auth.account.expiresAt - Date.now() > 60_000) return auth.account.accessToken;
  refreshing ??= refreshAccount(auth).then(async (next) => {
    await chatgptAuth.setValue(next);
    return next.account!.accessToken;
  }, async (error) => {
    // A rejected refresh token cannot recover; sign out so the UI asks to sign in again.
    if (error instanceof ChatGPTAuthError && error.reason === "expired") await signOutChatGPT();
    throw error;
  }).finally(() => { refreshing = undefined; });
  return refreshing;
}

export async function chatgptCredentials(): Promise<ChatGPTCredentials | undefined> {
  return (await chatgptAuth.getValue())?.account ? { accessToken } : undefined;
}

export async function listChatGPTModels() {
  return listModels(await accessToken());
}
