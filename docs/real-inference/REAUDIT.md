# Post-delivery adversarial re-audit

Publication note: this audit describes the original private delivery and v1.1
release. The application has since become public. Current instructions use the
already-public original DL revision with identical serving/build inputs and
release bytes; they do not require access to the private paired DL repository.
The v1.1 tag and evidence below are preserved. See the
[current setup](../real-pcb-inference.md) and
[public-checkout verification](../presentation-verification.md).

The user requested a second, deeper review of delivery `7bffb3a` after publication.
Both private repositories and their original CI runs were still clean/passing.
Passing those checks did not cover all relevant edge cases: this audit reproduced
the issues below and adds explicit regressions rather than relying on the earlier
clean review verdict. The corrected source has passed the checks below.

| Finding | Reproduction and correction |
| --- | --- |
| Expired lease could authorize a delayed result or failure write | The filter captured a client timestamp before MongoDB executed the write. New real-Mongo tests delayed each command beyond the stored lease expiry without reconciliation; both failed against the shipped code. Conditional writes now compare with MongoDB `$$NOW` at evaluation time while retaining attempt/generation/absent-result ownership guards. |
| A valid boundary box could crash annotation rendering | Pixel-to-normalized conversion can produce a sum of `1.0000000000000002`. Shared contracts already allow this floating-point tolerance; the canvas rejected it. Canvas validation now uses the shared tolerance without modifying original coordinates. Regressions include a float32 coordinate and actual editor rendering/save/reopen. |
| Model outage could block confirming a previously submitted inspection | A lost 202 response left an idempotent request snapshot, but upload-page readiness guards disabled its retry. Confirmation now reuses the same asset, key, provider and attestation during an outage; fresh trained requests still require availability. |
| Failed readiness refresh could display a stale success | TanStack Query retained earlier successful data after a failed recheck. The page now fails closed on the latest error and shows the failure message, while preserving the independent confirmation retry path. |
| Changing PCB attestation left stale saved-submission UI state | Fresh Astra review caught that changing the checkbox cleared the request snapshot but retained the uploaded-image state. The handler now clears both; ready and unavailable-service regressions verify that unchecked attestation cannot offer a stale confirmation. |
| `.env` could select a different DL checkout from the verifier | Compose read `DL_REPOSITORY_DIR` from `.env`; the verifier initially read only exported environment variables. Resolution now follows documented shell / project `.env` / default precedence and the harness passes the exact verified absolute directory into every Compose invocation. Literal paths with spaces, shell precedence, empty overrides and configuration drift have regression coverage. |
| Untracked serving source could enter a supposedly pinned build | The clean-tracked check ignored new nonignored files under `src`, which Docker copies into the Python build. Preflight now rejects those untracked serving inputs; ignored caches and unrelated notes remain permissible. A temporary Git fixture tests the guard. |

The audit also added explicit mock and trained-dispatch tests for a MongoDB result
write that commits successfully and then loses its acknowledgement. Both passed
even before the lease correction: the persisted original result remains completed,
redelivery does not call inference again, and reconciliation does not change it.
This fills a test gap without claiming a new production defect.

The refreshed [live acceptance record](acceptance.json) proves an actual typed
Python busy response traverses the queued worker and recovers: the busy failure
was observed on attempt two and completion on attempt three. Pausing the actual
Python container produced a durable HTTP timeout on attempt one and trained
completion on attempt two after restoration. No mock result was substituted.
These operational probes are excluded from latency samples. The original direct
Python capacity probe alone did not establish application-level retry coverage.

Validation: 396 unit/component tests and 24 Node guard/control checks passed,
with one pre-existing filesystem-dependent skip. The audit integration run passed
153 MongoDB/API tests and 20 Chromium tests, the production build passed, and the
full Docker reliability suite passed. The final live CPU run at
`b007a855a882230e029b80ae5c8ea340a83ecb4f` passed all eleven acceptance checks,
including real eight-class review/save/reopen, both existing mock container
browser workflows, outages, timeout/busy recovery and persisted review revision
two. It refreshed the 30 API and 20 browser timing samples and authentic captures.
The final attestation correction also passed both new component regressions and
the full unit suite. Exact measurement boundaries and limitations are in the
[acceptance report](REPORT.md).

A [fresh-checkout smoke](alternate-checkout.json) first ran the original mock
command with no DL clone. It then cloned the exact DL revision into `alternate dl`
and selected it only through project `.env`; verified source and Compose build
context agreed, actual trained inference completed, and the prior mock inspection
remained intact. These were clean local Git clones of the recorded commits, not
a claim of fetching an unpublished tag from GitHub.

The trained browser test and upload guidance now use the attributed sample already
in the SWE repository, so an alternate DL checkout does not require an additional
default sibling merely to locate a fixture. The README distinguishes the upstream
CI badge from the private integration workflow.
The DL API reference's obsolete future-integration wording and validation links
were corrected in documentation-only revision
`badae041458688f8743ce6d6f433f01a13451d0e`; the compatible checkout pin now selects
that revision while the serving source and release bundle remain unchanged.

The original `pcb-integration-v1` tag is preserved. Follow-up publication uses a
new `pcb-integration-v1.1` tag after checks and independent Astra medium review.
No model weights, release identity, taxonomy, operating threshold, or DL runtime
source change is part of these corrections.
