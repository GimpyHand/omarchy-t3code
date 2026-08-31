import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { forwardNativeCallback } from "../bridge/src/auth/nativeCallback.ts";
import { NativeClerkProvider } from "../bridge/src/auth/nativeProvider.ts";
import {
  activateT3ProtocolHandler,
  clearT3ProtocolDefault,
  installT3CallbackDesktop,
  type MimeCommand,
} from "../bridge/src/auth/protocolHandler.ts";
import {
  MemorySecretStore,
  SecretServiceStore,
  type SecretToolRunner,
} from "../bridge/src/security/secretStore.ts";

test("native Clerk browser flow returns a relay-audienced session credential", async () => {
  const store = new MemorySecretStore();
  await store.set("t3-connect-oauth", "legacy-cli-oauth-credential");
  const activeSession = {
    id: "session-browser",
    status: "active",
    user: {
      primary_email_address_id: "email-browser",
      email_addresses: [{ id: "email-browser", email_address: "browser@example.test" }],
    },
  };
  const relayClaims = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 300 })).toString("base64url");
  const relayJwt = `eyJhbGciOiJub25lIn0.${relayClaims}.signaturevalue`;
  const requests: Array<{ method: string; url: URL; headers: Headers; body: string }> = [];
  let signedIn = false;
  let relayTokenRequests = 0;
  const clerkFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET");
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    requests.push({ method, url, headers, body });
    const responseHeaders = { "content-type": "application/json", authorization: "Bearer clerk-native-client-token" };
    if (method === "GET" && url.pathname === "/v1/client") {
      return Response.json({
        response: {
          object: "client",
          sessions: signedIn ? [activeSession] : [],
          last_active_session_id: signedIn ? activeSession.id : null,
        },
        client: null,
      }, { headers: responseHeaders });
    }
    if (method === "POST" && url.pathname === "/v1/client/sign_ins") {
      return Response.json({
        response: {
          id: "sign-in-browser",
          first_factor_verification: {
            external_verification_redirect_url: "https://accounts.example.test/t3-connect",
          },
        },
        client: null,
      }, { headers: responseHeaders });
    }
    if (method === "GET" && url.pathname === "/v1/client/sign_ins/sign-in-browser") {
      signedIn = true;
      return Response.json({
        response: { id: "sign-in-browser", status: "complete" },
        client: {
          sessions: [activeSession],
          last_active_session_id: activeSession.id,
        },
      }, { headers: responseHeaders });
    }
    if (method === "POST" && url.pathname === "/v1/client/sessions/session-browser/tokens/t3-relay") {
      relayTokenRequests += 1;
      return Response.json({ response: { jwt: relayJwt }, client: null }, { headers: responseHeaders });
    }
    return Response.json({}, { status: 404 });
  };

  let handlerActivations = 0;
  let handlerRestorations = 0;
  const provider = new NativeClerkProvider({
    store,
    fetch: clerkFetch,
    callbackTimeoutMs: 2_000,
    activateProtocolHandler: async () => {
      handlerActivations += 1;
      return async () => { handlerRestorations += 1; };
    },
    openBrowser: async (landingUrl) => {
      const landing = new URL(landingUrl);
      assert.equal(landing.hostname, "127.0.0.1");
      const started = await fetch(new URL("/start?provider=google", landing), { redirect: "manual" });
      assert.equal(started.status, 302);
      assert.equal(started.headers.get("location"), "https://accounts.example.test/t3-connect");
      const unauthorized = await fetch(new URL("/oauth-callback", landing), {
        method: "POST",
        headers: { authorization: "Bearer wrong-callback-secret" },
        body: "t3code://app/?rotating_token_nonce=attacker",
      });
      assert.equal(unauthorized.status, 403);
      await forwardNativeCallback("t3code://app/?rotating_token_nonce=test-nonce", store);
    },
  });

  const status = await provider.login();
  assert.equal(status.phase, "signedIn");
  assert.equal(status.identity, "browser@example.test");
  assert.equal(handlerActivations, 1);
  assert.equal(handlerRestorations, 1);
  assert.equal(await store.get("t3-connect-oauth"), null);
  assert(await store.get("t3-connect-clerk-client"));
  assert.equal(await store.get("t3-connect-native-callback"), null);

  const signIn = requests.find((entry) => entry.method === "POST" && entry.url.pathname === "/v1/client/sign_ins");
  assert(signIn);
  assert.equal(signIn.headers.get("authorization"), "Bearer clerk-native-client-token");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(signIn.body)), {
    strategy: "oauth_google",
    redirect_url: "t3code://app/",
    action_complete_redirect_url: "t3code://app/",
  });
  const callback = requests.find((entry) => entry.url.pathname === "/v1/client/sign_ins/sign-in-browser");
  assert(callback);
  assert.equal(callback.url.searchParams.get("rotating_token_nonce"), "test-nonce");
  for (const entry of requests) {
    assert.equal(entry.url.searchParams.get("__clerk_api_version"), "2026-05-12");
    assert.equal(entry.url.searchParams.get("_clerk_js_version"), "6.29.2");
    assert.equal(entry.url.searchParams.get("_is_native"), "1");
    assert.equal(entry.url.searchParams.get("_electron_sdk_version"), "0.0.34");
  }

  const firstCredential = await provider.relayCredential();
  const secondCredential = await provider.relayCredential();
  assert.deepEqual(firstCredential, { token: relayJwt, kind: "clerk_session" });
  assert.deepEqual(secondCredential, firstCredential);
  assert.equal(relayTokenRequests, 1);
  const templateRequest = requests.find((entry) => entry.url.pathname.endsWith("/tokens/t3-relay"));
  assert(templateRequest);
  assert.equal(templateRequest.headers.get("authorization"), "Bearer clerk-native-client-token");

  const restarted = new NativeClerkProvider({ store, fetch: clerkFetch });
  const restartedStatus = await restarted.initialize();
  assert.equal(restartedStatus.phase, "signedIn");
  assert.equal(restartedStatus.identity, "browser@example.test");
  await provider.logout();
  assert.equal(await store.get("t3-connect-clerk-client"), null);
});

test("native Clerk password sign-in completes without a desktop callback", async () => {
  const store = new MemorySecretStore();
  const activeSession = {
    id: "session-inline",
    status: "active",
    user: {
      primary_email_address_id: "email-inline",
      email_addresses: [{ id: "email-inline", email_address: "inline@example.test" }],
    },
  };
  let signedIn = false;
  let signInId = "";
  const clerkFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET");
    const responseHeaders = { "content-type": "application/json", authorization: "Bearer clerk-native-client-token" };
    if (method === "GET" && url.pathname === "/v1/client") {
      return Response.json({
        response: {
          object: "client",
          sessions: signedIn ? [activeSession] : [],
          last_active_session_id: signedIn ? activeSession.id : null,
        },
        client: null,
      }, { headers: responseHeaders });
    }
    if (method === "POST" && url.pathname === "/v1/client/sign_ins") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      assert.equal(body.get("identifier"), "inline@example.test");
      assert.equal(body.get("password"), null);
      signInId = "sign-in-password";
      return Response.json({
        response: {
          object: "sign_in_attempt",
          id: signInId,
          status: "needs_first_factor",
        },
        client: null,
      }, { headers: responseHeaders });
    }
    if (method === "POST" && url.pathname === `/v1/client/sign_ins/${signInId}/attempt_first_factor`) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      assert.equal(body.get("strategy"), "password");
      assert.equal(body.get("password"), "secret-password");
      signedIn = true;
      return Response.json({
        response: {
          object: "sign_in_attempt",
          id: signInId,
          status: "complete",
        },
        client: {
          object: "client",
          sessions: [activeSession],
          last_active_session_id: activeSession.id,
        },
      }, { headers: responseHeaders });
    }
    return Response.json({}, { status: 404 });
  };

  const provider = new NativeClerkProvider({
    store,
    fetch: clerkFetch,
    callbackTimeoutMs: 2_000,
    activateProtocolHandler: async () => async () => undefined,
    openBrowser: async (landingUrl) => {
      const landing = new URL(landingUrl);
      const completed = await fetch(new URL("/sign-in/password", landing), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          identifier: "inline@example.test",
          password: "secret-password",
        }),
      });
      assert.equal(completed.status, 200);
    },
  });

  const status = await provider.login();
  assert.equal(status.phase, "signedIn");
  assert.equal(status.identity, "inline@example.test");
});

test("native Clerk email second-factor sign-in completes after password verification", async () => {
  const store = new MemorySecretStore();
  const activeSession = {
    id: "session-2fa",
    status: "active",
    user: {
      primary_email_address_id: "email-2fa",
      email_addresses: [{ id: "email-2fa", email_address: "twofactor@example.test" }],
    },
  };
  let signedIn = false;
  let signInId = "";
  const clerkFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET");
    const responseHeaders = { "content-type": "application/json", authorization: "Bearer clerk-native-client-token" };
    if (method === "GET" && url.pathname === "/v1/client") {
      return Response.json({
        response: {
          object: "client",
          sessions: signedIn ? [activeSession] : [],
          last_active_session_id: signedIn ? activeSession.id : null,
        },
        client: null,
      }, { headers: responseHeaders });
    }
    if (method === "POST" && url.pathname === "/v1/client/sign_ins") {
      signInId = "sign-in-2fa";
      return Response.json({
        response: {
          object: "sign_in_attempt",
          id: signInId,
          status: "needs_first_factor",
        },
        client: null,
      }, { headers: responseHeaders });
    }
    if (method === "POST" && url.pathname === `/v1/client/sign_ins/${signInId}/attempt_first_factor`) {
      return Response.json({
        response: {
          object: "sign_in_attempt",
          id: signInId,
          status: "needs_second_factor",
          supported_second_factors: [{
            strategy: "email_code",
            email_address_id: "email-2fa",
          }],
        },
        client: null,
      }, { headers: responseHeaders });
    }
    if (method === "POST" && url.pathname === `/v1/client/sign_ins/${signInId}/prepare_second_factor`) {
      return Response.json({
        response: {
          object: "sign_in_attempt",
          id: signInId,
          status: "needs_second_factor",
        },
        client: null,
      }, { headers: responseHeaders });
    }
    if (method === "POST" && url.pathname === `/v1/client/sign_ins/${signInId}/attempt_second_factor`) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      assert.equal(body.get("strategy"), "email_code");
      assert.equal(body.get("code"), "123456");
      signedIn = true;
      return Response.json({
        response: {
          object: "sign_in_attempt",
          id: signInId,
          status: "complete",
        },
        client: null,
      }, { headers: responseHeaders });
    }
    return Response.json({}, { status: 404 });
  };

  const provider = new NativeClerkProvider({
    store,
    fetch: clerkFetch,
    callbackTimeoutMs: 2_000,
    activateProtocolHandler: async () => async () => undefined,
    openBrowser: async (landingUrl) => {
      const landing = new URL(landingUrl);
      const passwordStep = await fetch(new URL("/sign-in/password", landing), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          identifier: "twofactor@example.test",
          password: "secret-password",
        }),
      });
      assert.equal(passwordStep.status, 200);
      assert.match(await passwordStep.text(), /Verify your sign-in/u);
      const codeStep = await fetch(new URL("/sign-in/second-factor", landing), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: "123456" }),
      });
      assert.equal(codeStep.status, 200);
    },
  });

  const status = await provider.login();
  assert.equal(status.phase, "signedIn");
  assert.equal(status.identity, "twofactor@example.test");
});

test("native callback forwarding rejects unexpected schemes and missing pending state", async () => {
  const store = new MemorySecretStore();
  await assert.rejects(
    forwardNativeCallback("https://app.t3.codes/?rotating_token_nonce=value", store),
    (error: unknown) => (error as { code?: string }).code === "AUTH_CALLBACK_INVALID",
  );
  await assert.rejects(
    forwardNativeCallback("t3code://app/?rotating_token_nonce=value", store),
    (error: unknown) => (error as { code?: string }).code === "AUTH_CALLBACK_NOT_PENDING",
  );
});

test("T3 callback handler temporarily preserves an existing desktop owner", async () => {
  let current = "t3code-nightly.desktop";
  const calls: string[][] = [];
  const command: MimeCommand = async (args) => {
    calls.push(args);
    if (args[0] === "query") return { code: 0, stdout: `${current}\n`, stderr: "" };
    assert.equal(args[0], "default");
    current = args[1] ?? "";
    return { code: 0, stdout: "", stderr: "" };
  };
  let desktopRemoved = false;
  const restore = await activateT3ProtocolHandler({
    command,
    registerDesktop: async () => async () => { desktopRemoved = true; },
  });
  assert.equal(current, "bralyx.t3code-callback.desktop");
  await restore();
  assert.equal(current, "t3code-nightly.desktop");
  assert.equal(desktopRemoved, true);
  assert(calls.some((args) => args.join(" ").includes("x-scheme-handler/t3code")));
});

test("legacy callback ownership is restored after the login window", async () => {
  let current = "io.github.omarchy-t3code-callback.desktop";
  const command: MimeCommand = async (args) => {
    if (args[0] === "query") return { code: 0, stdout: `${current}\n`, stderr: "" };
    current = args[1] ?? "";
    return { code: 0, stdout: "", stderr: "" };
  };
  const restore = await activateT3ProtocolHandler({
    command,
    registerDesktop: async () => async () => undefined,
  });
  assert.equal(current, "bralyx.t3code-callback.desktop");
  await restore();
  assert.equal(current, "io.github.omarchy-t3code-callback.desktop");
});

test("callback handler clears a newly created default before removing its desktop entry", async () => {
  let current = "";
  let cleared = false;
  let removed = false;
  const command: MimeCommand = async (args) => {
    if (args[0] === "query") return { code: 0, stdout: `${current}\n`, stderr: "" };
    current = args[1] ?? "";
    return { code: 0, stdout: "", stderr: "" };
  };
  const restore = await activateT3ProtocolHandler({
    command,
    clearDefault: async () => { current = ""; cleared = true; },
    registerDesktop: async () => async () => { removed = true; },
  });
  assert.equal(current, "bralyx.t3code-callback.desktop");
  await restore();
  assert.equal(current, "");
  assert.equal(cleared, true);
  assert.equal(removed, true);
});

test("callback desktop registration is hidden, quoted, and removed after login", async () => {
  const root = await mkdtemp(join(tmpdir(), "t3-callback-desktop-"));
  const data = join(root, "data");
  const desktop = join(data, "applications", "bralyx.t3code-callback.desktop");
  try {
    const removeDesktop = await installT3CallbackDesktop(
      { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: data },
      ["/opt/T3 Mini/t3-mini-bridge"],
    );
    const contents = await readFile(desktop, "utf8");
    assert.match(contents, /^NoDisplay=true$/mu);
    assert.match(contents, /^MimeType=x-scheme-handler\/t3code;$/mu);
    assert.match(contents, /^Exec="\/opt\/T3 Mini\/t3-mini-bridge" --oauth-callback %u$/mu);
    await removeDesktop();
    await assert.rejects(access(desktop), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clearing an ephemeral callback default preserves other MIME owners", async () => {
  const root = await mkdtemp(join(tmpdir(), "t3-callback-mimeapps-"));
  const config = join(root, "config");
  const mimeapps = join(config, "mimeapps.list");
  try {
    await mkdir(config, { recursive: true });
    await writeFile(mimeapps, [
      "[Default Applications]",
      "x-scheme-handler/t3code=bralyx.t3code-callback.desktop;t3code-nightly.desktop;",
      "text/plain=org.example.Editor.desktop;",
      "",
    ].join("\n"));
    await clearT3ProtocolDefault(
      "bralyx.t3code-callback.desktop",
      { HOME: root, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, "data") },
    );
    const contents = await readFile(mimeapps, "utf8");
    assert.match(contents, /^x-scheme-handler\/t3code=t3code-nightly\.desktop;$/mu);
    assert.match(contents, /^text\/plain=org\.example\.Editor\.desktop;$/mu);
    assert.doesNotMatch(contents, /bralyx\.t3code-callback/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Secret Service values migrate from the development application ID", async () => {
  const currentApplication = "bralyx.t3code";
  const legacyApplication = "io.github.omarchy-t3code";
  const values = new Map([[`${legacyApplication}:t3-connect-clerk-client`, "saved-client-token"]]);
  const tool: SecretToolRunner = async (args, input) => {
    const application = args[args.indexOf("application") + 1] ?? "";
    const item = args[args.indexOf("item") + 1] ?? "";
    const key = `${application}:${item}`;
    if (args[0] === "lookup") {
      const value = values.get(key);
      return value === undefined
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: `${value}\n`, stderr: "" };
    }
    if (args[0] === "store") {
      values.set(key, input ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "clear") {
      values.delete(key);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected secret-tool operation ${args[0]}.`);
  };
  const store = new SecretServiceStore(currentApplication, [legacyApplication], tool);
  assert.equal(await store.get("t3-connect-clerk-client"), "saved-client-token");
  assert.equal(values.get(`${currentApplication}:t3-connect-clerk-client`), "saved-client-token");
  assert.equal(values.has(`${legacyApplication}:t3-connect-clerk-client`), false);
  await store.remove("t3-connect-clerk-client");
  assert.equal(values.size, 0);
});
