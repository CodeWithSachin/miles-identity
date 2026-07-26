/**
 * GET /sign-in — the hosted login page Better Auth's `loginPage: "/sign-in"`
 * (src/auth.ts) redirects an unauthenticated `/oauth2/authorize` request to.
 *
 * Masterclass web is the first product wired to a real page here (prompts/009)
 * — a single hard-coded theme, no per-`client_id` theme registry, since no
 * second product has integrated yet (AGENTS.md: build for the product in front
 * of you, not a speculative future one).
 *
 * Static HTML/CSS/vanilla JS, no bundler (matches src/routes/docs.ts's Scalar
 * page). Calls only existing, already enumeration-safe endpoints:
 *   - POST /api/identity/resolve      → which methods to offer for a handle
 *   - POST /api/auth/sign-in/email    → password
 *   - POST /api/auth/sign-in/otp/start|verify → email/SMS OTP
 * Adds no new JSON API of its own.
 */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — Masterclass</title>
<style>
  :root { --mc-primary: #7c3aed; --mc-bg: #0f0a1a; --mc-fg: #f5f3ff; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--mc-bg); color: var(--mc-fg);
    font-family: system-ui, -apple-system, sans-serif;
  }
  main { width: 100%; max-width: 360px; padding: 2rem; }
  .brand { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 2rem; font-weight: 600; font-size: 1.25rem; }
  .brand-mark { width: 28px; height: 28px; border-radius: 8px; background: var(--mc-primary); }
  label { display: block; font-size: 0.875rem; margin: 1rem 0 0.25rem; }
  input {
    width: 100%; padding: 0.625rem 0.75rem; border-radius: 8px; border: 1px solid #3f3358;
    background: #1a1329; color: var(--mc-fg); font-size: 1rem;
  }
  button {
    width: 100%; margin-top: 1.25rem; padding: 0.625rem; border-radius: 8px; border: none;
    background: var(--mc-primary); color: white; font-size: 1rem; cursor: pointer;
  }
  button.secondary { background: transparent; border: 1px solid #3f3358; margin-top: 0.5rem; }
  button:disabled { opacity: 0.6; cursor: not-allowed; }
  .msg { min-height: 1.25rem; margin-top: 0.75rem; font-size: 0.875rem; color: #f5a3a3; }
  .hidden { display: none; }
</style>
</head>
<body>
<main>
  <div class="brand"><span class="brand-mark"></span> Masterclass</div>

  <form id="handle-form">
    <label for="handle">Email or phone</label>
    <input id="handle" name="handle" autocomplete="username" required>
    <button type="submit">Continue</button>
    <div class="msg" id="handle-msg"></div>
  </form>

  <form id="password-form" class="hidden">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
    <button type="button" class="secondary" id="use-otp">Email me a code instead</button>
    <div class="msg" id="password-msg"></div>
  </form>

  <form id="otp-form" class="hidden">
    <label for="otp">Code</label>
    <input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" required>
    <button type="submit">Verify</button>
    <div class="msg" id="otp-msg"></div>
  </form>
</main>
<script>
  var handle = "";

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    }).then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); });
  }

  document.getElementById("handle-form").addEventListener("submit", function (e) {
    e.preventDefault();
    handle = document.getElementById("handle").value;
    post("/api/identity/resolve", { handle: handle }).then(function (r) {
      document.getElementById("handle-form").classList.add("hidden");
      if (r.data.methods && r.data.methods.indexOf("password") !== -1) {
        document.getElementById("password-form").classList.remove("hidden");
      } else {
        startOtp();
      }
    });
  });

  function startOtp() {
    post("/api/auth/sign-in/otp/start", { handle: handle }).then(function () {
      document.getElementById("password-form").classList.add("hidden");
      document.getElementById("otp-form").classList.remove("hidden");
    });
  }

  document.getElementById("use-otp").addEventListener("click", startOtp);

  document.getElementById("password-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var password = document.getElementById("password").value;
    post("/api/auth/sign-in/email", { email: handle, password: password }).then(function (r) {
      var msg = document.getElementById("password-msg");
      msg.textContent = r.ok ? "" : "Invalid email or password.";
      if (r.ok) window.location.reload();
    });
  });

  document.getElementById("otp-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var otp = document.getElementById("otp").value;
    post("/api/auth/sign-in/otp/verify", { handle: handle, otp: otp }).then(function (r) {
      var msg = document.getElementById("otp-msg");
      msg.textContent = r.ok ? "" : "Invalid or expired code.";
      if (r.ok) window.location.reload();
    });
  });
</script>
</body>
</html>`;

/** Static: dispatched by Bun.serve with zero allocation, matches src/routes/docs.ts.
 * `Cache-Control: no-store` — an auth page must never be cached. */
export const signInPage = new Response(PAGE, {
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
});
