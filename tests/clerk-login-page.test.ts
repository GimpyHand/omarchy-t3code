import assert from "node:assert/strict";
import test from "node:test";

import { buildClerkLoginPage, buildSecondFactorPage } from "../bridge/src/auth/clerkLoginPage.ts";

test("login page exposes email/password sign-in and social fallbacks", () => {
  const html = buildClerkLoginPage();
  assert.match(html, /action="\/sign-in\/password"/u);
  assert.match(html, /name="identifier"/u);
  assert.match(html, /name="password"/u);
  assert.match(html, /\/start\?provider=google/u);
  assert.match(html, /\/start\?provider=github/u);
  assert.doesNotMatch(html, /clerk\.browser/u);
});

test("second-factor page accepts a verification code", () => {
  const html = buildSecondFactorPage({ message: "Check your email." });
  assert.match(html, /action="\/sign-in\/second-factor"/u);
  assert.match(html, /name="code"/u);
  assert.match(html, /Check your email/u);
});
