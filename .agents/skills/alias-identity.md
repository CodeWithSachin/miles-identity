# Skill: alias-identity

The core domain. Read before touching login, identity resolution, merge, dedup, or anything that reads `user_identity`.

---

## The premise

**An email or phone number is not an identity. It is a handle that points at one.**

Three legacy systems keyed users on different handles, so the same human exists 2–3 times. One global `user` row per human; unlimited verified handles pointing at it. Every product downstream sees one `usr_` id and stops caring which handle the person typed.

```
                    user: usr_9988  (immutable, forever)
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
  email/personal@…     email/work@…         phone/+9199999…
  verified, primary    verified             verified, primary
```

## Login resolution

```
handle typed → normalise → SELECT user_id FROM user_identity
                            WHERE type=$1 AND value=$2 AND is_verified=true
    ├── no match → generic response, rate limited
    └── match    → offer methods available to that user
                 → OTP goes to the handle they typed
                 → session is always for the global user id
```

### Normalisation — before the query, never on read

- **Email:** trim, lowercase. Do **not** strip Gmail dots or `+tags` — two handles that differ textually are two handles. Stripping them silently merges accounts.
- **Phone:** E.164. Bare 10-digit Indian numbers get `+91`, but **validate that assumption against a real sample before relying on it in a batch job.** A wrong country prefix mis-merges people.

Store the normalised form. Comparing normalised-on-read against raw-in-database is a bug that hides until it merges two strangers.

## The two rules that prevent takeover

**1. Only `is_verified = true` may authenticate or receive an OTP.**

An unverified alias that can log in means anyone can claim `ceo@miles.com` and log in as them. Salesforce-provisioned identities start unverified precisely because Lead conversion is not identity verification.

**2. Linking OTPs go to the ALREADY-VERIFIED handle.**

```
User claims a new handle
  → send OTP to an EXISTING VERIFIED handle on the account   ← this direction
  → NOT to the newly claimed handle                          ← this is the takeover
  → on success, attach the new handle as verified
```

Sending to the new handle lets an attacker attach their own address to someone else's account.

## `/api/identity/resolve` is an enumeration oracle

It answers "does this handle exist here?" Treat it as hostile.

- Identical response **shape** for hit and miss.
- Identical response **timing** — do not return early on miss. Constant-time-ish path or a fixed floor.
- Rate limit per IP **and** per handle. A slow scan from many IPs against one handle is also an attack.
- Never differentiate messages: "no account found" vs "wrong password" leaks the same fact.
- Alert on scan patterns.

## Deduplication — tiered confidence, never blind

Run before SSO goes live. Output is a **reviewed mapping table**, not an automatic merge.

| Tier | Rule | Action |
|---|---|---|
| A | Same `salesforce_contact_id` | auto-merge |
| B | Identical verified email | auto-merge |
| C | Identical E.164 phone **and** name similarity ≥ 0.9 | auto-merge |
| D | Identical phone, different name | **manual review** |
| E | Same name + institution, no shared handle | **manual review** |

**Tier D is the trap.** Shared family and office numbers are common in this user base. Merging two different people into one account is a data breach that is very hard to unwind. **Never auto-merge on phone alone.** If a plan proposes it, reject the plan.

## Merge procedure — reversible, in one transaction

```
1. Pick survivor: oldest verified account, or the Salesforce-linked one
2. Move all identities to survivor; first verified per type becomes is_primary
3. Union product access — widest role wins, log the widening
4. INSERT identity_merge_log { survivor, merged, tier, evidence, actor }
5. Loser: status='merged', merged_into_user_id=survivor   ← NEVER DELETE
6. Update each product DB identity_user_id → survivor
7. Revoke BOTH users' sessions and refresh tokens
```

Steps 1–5 in a single `Bun.sql` transaction.

**Why step 5 never deletes:** a stale reference resolves to the survivor instead of 404-ing, and the merge stays reversible for the inevitable "you merged the wrong two people" ticket.

**Why step 7 exists:** tokens carrying the merged-away `sub` stay valid for the whole access-token window otherwise. Skipping it means a ghost identity keeps working for up to 15 minutes.

## Lazy consolidation at login

For handles the batch missed:

```
Unrecognised handle, but matches an existing user by another signal
  → "We found an existing Miles account. Verify to link them."
  → OTP to the existing verified handle
  → attach as verified alias
```

Never link automatically on an email match. That is the federated-login takeover path in a different coat.

## Invariants to assert in tests

Every one of these gets a test. They are the properties the whole model rests on.

- `UNIQUE (type, value)` holds globally — a handle never points at two users.
- Exactly one `is_primary = true` per (`user_id`, `type`).
- An unverified identity cannot authenticate. **Negative test required.**
- An unverified identity cannot receive a sign-in OTP.
- After a merge, the merged user id still resolves to the survivor.
- After a merge, both users' sessions are gone.
- `resolve` returns identical shape for hit and miss.
- Adding an alias sends the OTP to the existing verified handle, not the new one.
- Normalisation is idempotent: `normalise(normalise(x)) === normalise(x)`.
