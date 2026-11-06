# Task 4A — same-execution-identity model eligibility contract

Engineering-only supplement to draft PR #1009 and original issue #969. This document does not grant owner approval, renew deadlines, modify production registry data, issue paid calls, dispatch GitHub, or certify protected Preview acceptance.

## Confirmed original execution identity

- Protected workflow: `.github/workflows/autonomous-development.yml`, run on `mfackrell/katie`'s trusted main-branch checkout.
- Native host: `scripts/benchmark/native-development-host.mjs`.
- Provider credential: **GitHub Actions repository secret `OPENAI_API_KEY`**. The native host reads it via `process.env.OPENAI_API_KEY` and sends it only server-side through `createResponsesProvider` in `scripts/benchmark/native-provider-receipts.mjs`.
- Paid endpoint: `POST https://api.openai.com/v1/responses`, model pinned to `gpt-5.3-codex`, default service tier.
- Current implementation sends **no** `OpenAI-Organization` or `OpenAI-Project` headers. The organization/project is implicitly scoped by the GitHub secret. Its concrete ID and key owner **cannot be established from repository source or Vercel's distinct production key**. No credential values should be logged, exported, or copied to an agent sandbox.
- The production Vercel server holds its own `OPENAI_API_KEY` setting, but GitHub Actions repository secrets are not automatically inherited from Vercel. Do **not** use a Vercel read-only check as a substitute for GitHub Actions' execution credential.

## Trustworthy nonbillable proof

Official OpenAI model resource reference: https://developers.openai.com/api/reference/resources/models/methods/retrieve

A separately authorized trusted process must issue **GET** `https://api.openai.com/v1/models/gpt-5.3-codex` with **the same GitHub Actions `OPENAI_API_KEY` secret** and **the same header context** as the real native Responses client. The result must be HTTP 200 with JSON `object: "model"` and `id: "gpt-5.3-codex"`; no generation request or paid inference probe is permitted. The response demonstrates model *visibility to that key*, not a guarantee of `responses.create` permissions, spend limits or later availability. On any uncertainty, deny admission rather than substituting a different key/model.

The protected host's `retrieveNativeModelNonbillable` performs only this GET and returns a nonsecret receipt; `nativeCredentialBinding` HMAC-binds the credential/key-default context to `KATIE_NATIVE_HANDOFF_HMAC_KEY` without storing or printing either secret. A future independently authenticated evidence-import step must safely attach its receipt to `model_registry.source_metadata.task4a_credential_lookup` under separate production authorization; **this PR does not invent a trusted issuer or write that record**.

Required receipt fields: `version=task4a-native-model-lookup-v1`, `source=openai.models.retrieve`, `method=GET`, official model endpoint, `model=gpt-5.3-codex`, `responseObject=model`, `httpStatus=200`, `credentialSource=github-actions:OPENAI_API_KEY`, `organizationContext=key-default`, `projectContext=key-default`, `proofLevel=credential_scoped_model_visibility_not_responses_create`, `credentialBinding` (64-hex HMAC), `releaseSha` (exact production/native-main SHA), `githubRepository=mfackrell/katie`, `githubWorkflow=.github/workflows/autonomous-development.yml`, `trustedProducer=protected-main-read-only-model-lookup`, `observedAt`, and `expiresAt` (maximum 15-minute lifetime).

## Admission requirements (all mandatory)

- Registry model `gpt-5.3-codex`, active, with `capability_status=verified`, `routing_eligibility=verified`, fresh (within 15 minutes) `capability_verified_at`; **`heuristic` and `restricted` always fail**.
- Independently sourced, fresh (within 24 hours) official default-tier prices exactly $1.75 / million input and $14 / million output, with `pricing_status=verified` and official source link.
- A current same-GitHub-secret read-only receipt from the exact approved release, valid for at most 15 minutes, with correct model, endpoint, source, context and well-formed HMAC.
- On the native host, **a fresh nonbillable GET using the real current GitHub Actions secret**, plus constant-time matching of the actual credential HMAC against the independently recorded receipt **before any execution grant**.
- The PostgreSQL `task4a_postpaid_model_eligible` denies the owner quote, paid consent and native execution grant if these fields are absent, mismatched, expired or unverified. The `task4a_native_live` postpaid wrapper additionally denies **every model-request admission** when evidence has expired or changed.

## Security limits, immutable history, and next decision

This is an **execution-deny-by-default** correction, not an assertion of verified live model availability. Since this engineering request forbids access to or disclosure of the GitHub Actions secret, paid inference, and production registry changes, no credential-scoped proof has been collected or committed. Consequently **owner approval and paid admission remain blocked**. No application source, project identity, issue #969, checkpoint `8e53ce01693303fc50daf5da1567e93e725f9b2d`, previous four settled calls / 49,620 tokens, or either protected reserve was changed.

The minimum further decision is **separate owner authorization for a main-branch, nonbillable same-secret model-lookup and authenticated evidence import**, after qualified code release; only then can an owner obtain a fresh quote. If OpenAI's read-only result cannot establish sufficiently strong current access, a separate account-scoped permissions/entitlement confirmation is required. A paid Responses probe requires **another** explicit authorization and is forbidden by this task.

OpenAI announced GPT-5.3-Codex deprecation on October 1, 2026, with scheduled shutdown April 1, 2027: https://developers.openai.com/api/docs/deprecations . The deprecation is not itself a permission verdict.

CI fixture evidence uses synthetic GET results and a disposable model registry; **no** mock receipt is inserted in production or represented as actual provider permission.
