export interface ClerkLoginPageConfig {
  errorMessage?: string;
}

export interface SecondFactorPageConfig {
  message: string;
  errorMessage?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildClerkLoginPage(config: ClerkLoginPageConfig = {}): string {
  const error = config.errorMessage
    ? `<p class="error">${escapeHtml(config.errorMessage)}</p>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Sign in · T3 Connect</title><style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(145deg,#101018,#1c1b2b);color:#f1f0fa;padding:1rem}.panel{width:min(28rem,calc(100vw - 2rem));padding:1.5rem;border:1px solid #55516b;background:#191824;border-radius:.75rem}h1{font-size:1.35rem;margin:0 0 .5rem}p{color:#bbb7cd;line-height:1.55;margin:0 0 1rem;font-size:.95rem}.error{color:#ffb4b4;margin-bottom:1rem}form{display:flex;flex-direction:column;gap:.85rem}label{display:flex;flex-direction:column;gap:.35rem;font-size:.85rem;color:#bbb7cd}input{border:1px solid #6b6686;border-radius:.5rem;padding:.75rem 1rem;background:#12111a;color:#f1f0fa;font:inherit}input:focus{outline:2px solid #7c78a8;outline-offset:1px}button{border:0;border-radius:.5rem;padding:.8rem 1rem;background:#4f46bb;color:#fff;font:inherit;font-weight:600;cursor:pointer}button:hover{background:#5b52c9}.providers{display:flex;flex-direction:column;gap:.65rem;margin-top:1.25rem;padding-top:1.25rem;border-top:1px solid #3a374d}.providers p{margin:0 0 .35rem;font-size:.8rem;color:#8f8aa3}.providers a{border:1px solid #6b6686;border-radius:.5rem;padding:.7rem 1rem;color:#f1f0fa;text-decoration:none;text-align:center;background:#29273a;font-size:.9rem}.providers a:focus,.providers a:hover{background:#37334c}.return{font-size:.8rem;margin:1rem 0 0;color:#8f8aa3}
</style></head><body><main class="panel"><h1>Connect Omarchy to T3</h1><p>Sign in with the same T3 Connect account you use in T3 Code desktop.</p>${error}<form method="post" action="/sign-in/password" autocomplete="on"><label>Email<input type="email" name="identifier" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Sign in with email</button></form><section class="providers"><p>Or continue with a linked provider.</p><a href="/start?provider=google">Continue with Google</a><a href="/start?provider=github">Continue with GitHub</a></section><p class="return">After sign-in, the mini client will bring T3 Command Center back into view.</p></main></body></html>`;
}

export function buildSecondFactorPage(config: SecondFactorPageConfig): string {
  const error = config.errorMessage
    ? `<p class="error">${escapeHtml(config.errorMessage)}</p>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Verify sign-in · T3 Connect</title><style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(145deg,#101018,#1c1b2b);color:#f1f0fa;padding:1rem}.panel{width:min(28rem,calc(100vw - 2rem));padding:1.5rem;border:1px solid #55516b;background:#191824;border-radius:.75rem}h1{font-size:1.35rem;margin:0 0 .5rem}p{color:#bbb7cd;line-height:1.55;margin:0 0 1rem;font-size:.95rem}.error{color:#ffb4b4;margin-bottom:1rem}form{display:flex;flex-direction:column;gap:.85rem}label{display:flex;flex-direction:column;gap:.35rem;font-size:.85rem;color:#bbb7cd}input{border:1px solid #6b6686;border-radius:.5rem;padding:.75rem 1rem;background:#12111a;color:#f1f0fa;font:inherit;letter-spacing:.08em}input:focus{outline:2px solid #7c78a8;outline-offset:1px}button{border:0;border-radius:.5rem;padding:.8rem 1rem;background:#4f46bb;color:#fff;font:inherit;font-weight:600;cursor:pointer}button:hover{background:#5b52c9}.return{font-size:.8rem;margin:1rem 0 0;color:#8f8aa3}
</style></head><body><main class="panel"><h1>Verify your sign-in</h1><p>${escapeHtml(config.message)}</p>${error}<form method="post" action="/sign-in/second-factor" autocomplete="one-time-code"><label>Verification code<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus></label><button type="submit">Continue to T3 Command Center</button></form><p class="return">After verification, the mini client will bring T3 Command Center back into view.</p></main></body></html>`;
}
