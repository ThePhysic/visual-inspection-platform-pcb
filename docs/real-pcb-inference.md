# Optional real PCB inference

The default demo remains independent and simulated. Real mode adds a private
FastAPI container from the independently runnable DL repository; there is no
third integration application, second queue, or training trigger. Human corrections
remain application data and never update weights.

## Compatible checkouts and release

Use sibling clones named `visual-inspection-platform` and `visual-inspection-dl`.
Private delivery copies preserve each original repository's history; their
upstream public remotes are unchanged. The final platform delivery is tagged
`pcb-integration-v1.1`; the acceptance report records the exact tested source commit.

```powershell
git clone --branch pcb-integration-v1.1 https://github.com/ThePhysic/visual-inspection-platform-pcb.git visual-inspection-platform
git clone https://github.com/ThePhysic/visual-inspection-dl-pcb.git visual-inspection-dl
git -C visual-inspection-dl checkout badae041458688f8743ce6d6f433f01a13451d0e
cd visual-inspection-platform
node infra/real/verify-release.mjs
```

The pinned DL checkout adds reciprocal documentation to serving source revision
`399a8da7407689a0ffd7dc9bde074600dd8dcbcc`. The compatibility file is
[`infra/real/compatibility.json`](../infra/real/compatibility.json). Verification
checks the exact clean tracked checkout, rejects untracked serving files under
`src` that would enter the Docker build, and checks the weights/evaluation hashes before
the acceptance runner builds anything. Serving independently verifies canonical
metadata and bundle contents when loading.

| Identity | Pinned value |
| --- | --- |
| Provider / backend | `visual-inspection-dl` / `trained` |
| Model ID / release | `pcb-ind-ssdlite` / `pcb-ind-ssdlite-v1` |
| Taxonomy | `pcb-ind-v4-1` |
| Artifact digest | `9037234654bcc190f6f5dd8cda07e70a119ba19b139b2b99118f4d9f27d7e05e` |
| Confidence / NMS thresholds | `0.20` / `0.55` |
| Weights SHA-256 | `28271a688aa7335521bb7725423fd6ea6622f3d1964bfaed83dd97b4f0ff34d9` |
| Effective detection limit | 100 per image |

A changed release requires explicit new configuration, compatibility review, and
tests. Relabeling different weights with the pinned identity is unsupported.

To use another checkout location, set a literal `DL_REPOSITORY_DIR` path in the
platform's `.env` or export it in the shell. The exported value takes precedence;
an explicitly empty value selects the default sibling path, as Compose's `:-`
expansion does. Relative paths resolve from the platform directory. Preflight and
the real acceptance runner select the same checkout; the runner passes the exact
verified absolute path to every Compose command. Variable interpolation in this
`.env` setting and custom `COMPOSE_ENV_FILES` / `COMPOSE_DISABLE_ENV_FILE` settings
are rejected by preflight rather than risking verification of a different source.

## Run either mode

Docker Desktop with Linux containers or Docker Engine with Compose is required.
No GPU, cloud account, raw dataset download, or external credential is required
to run a checked-out project. Private GitHub clones require repository access.
The CPU image's first build downloads Python dependencies, not model weights.

Original simulated quick start, from the platform alone:

```powershell
docker compose -p vip-demo up -d --build --wait --wait-timeout 120
```

Optional trained stack, with the pinned sibling DL clone:

```powershell
node infra/real/verify-release.mjs
docker compose -p vip-pcb -f compose.yaml -f compose.real.yaml up -d --build --wait --wait-timeout 180
```

Open `http://127.0.0.1:8080`, press **Check trained model availability**, select
**Trained PCB detector**, and choose a JPEG from `fixtures/pcb`. Confirm that the
image is an actual 300×300 PCB candidate patch. Upload and inspect, then open the
review editor, reject/relabel a prediction or draw a missed defect, save, refresh,
and reopen it from history. The UI defaults to simulated mode for each new upload.
The fixture [manifest and attribution](../fixtures/pcb/README.md) identify source,
license and audited training/holdout provenance. Existing synthetic mock fixtures
continue to work only as simulated examples.

Only the existing web frontend binds a loopback host port. Python has no host
port mapping, runs as the DL Dockerfile's non-root user, uses CPU, and mounts its
pinned release read-only. Neither the browser nor public request handling performs
prediction. A background monitor polls bounded readiness/model-identity endpoints
every five seconds and expires observations after ten seconds. Public requests
read that cached observation and never await Python;
the existing worker alone calls `/v1/predict` for inspections.

```powershell
docker compose -p vip-pcb -f compose.yaml -f compose.real.yaml ps
docker compose -p vip-pcb -f compose.yaml -f compose.real.yaml logs --tail 60 api worker
docker compose -p vip-pcb -f compose.yaml -f compose.real.yaml down
```

`down` preserves named database/image volumes. Use the same project name and files
to restart. Do not add `--volumes` when retaining inspection history.

## Contracts, review and failure behavior

Admission requires explicit `candidatePatch: true`, canonical dimensions 300×300,
and enabled integration. This is a user domain assertion, not an automated PCB
classifier; dimensions alone cannot establish image semantics. Full-board search,
arbitrary-image resizing, automatic cropping, and tiling are excluded.

The API stores the complete selected provider configuration and attestation and
includes them in idempotency. An identical key replays durable acceptance even
during later outages; provider changes conflict. Linked retries retain identity.
Already accepted work does not depend on current live readiness.

The adapter sends canonical oriented bytes with their exact MIME type, caps its
JSON response at 256 KiB, and validates backend, release, taxonomy, digest, labels,
scores, dimensions and every pixel box. It preserves unrounded normalized geometry,
uses deterministic IDs, and separates HTTP duration from Python timing fields.
Empty predictions succeed. A result's simulated flag alone never establishes trust.

The controlled taxonomy registry supports the original two mock classes and
`mouse_bite`, `missing_copper`, `scratch`, `spurious_copper`, `copper_burr`, `stain`,
`short`, and `open`. Every original prediction appears exactly once in a saved
review as accepted/rejected; additions have manual origin and no invented score.
Review validation binds to the original inspection identity. Existing revision,
write-sequence, operation-receipt and draft-navigation protections remain.

Connection failures, HTTP 503/busy, interruptions and timeouts use the existing
finite three-attempt budget. Invalid successful responses or permanent image/request
errors terminate. There is no automatic fixture/mock fallback or adapter retry loop.
Cancellation reaches HTTP, but Python computation can continue; lease ownership
and conditional commits fence late results. The initial worker remains concurrency
one. The bounded HTTP deadline is 8 seconds, inside the existing 10-second attempt
deadline and 30-second lease. Measurement evidence and its limits are recorded in
the acceptance report; this is not an SLA or a claim about slower machines.

Application liveness, Mongo/Redis/storage health, and trained-model availability
are distinct. `GET /api/v1/inference-modes` reports only safe availability data.
Worker health additionally reports trained availability. Correlated structured
logs contain bounded provider/model/outcome codes and queue/provider/commit
durations, without image bytes or raw remote exceptions. Operator metrics retain
bounded labels and private listeners.

## Reproduce verification and measurements

Use the pinned Node/pnpm versions from `.node-version` and `package.json`:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @vip/web exec playwright install chromium
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:ci:integration
pnpm test:reliability
pnpm test:real --ci-mongodb
```

The isolated real runner verifies the release, builds the six-service stack, probes
actual trained inference and busy responses over the private network, runs the
trained browser suite, measures repeated workflows, exercises outage recovery,
and verifies persistence across down/up. It owns uniquely named test resources
and removes only those resources. `--ci-mongodb` selects the repository's existing
MongoDB allocator compatibility override; ordinary application startup omits it.
See the [acceptance report](real-inference/REPORT.md) for commands actually run,
sample counts, revisions, pass/fail outcomes and limitations. The DL repository
retains its independent Python test and serving commands.

Raw measurements separate asset acceptance, inspection creation, queue wait,
worker HTTP/JSON time, Python decode/model/postprocess, commit, API-observed
completion, and actual browser visibility. API observation polls every 100 ms;
the browser polls every 2 seconds. Report p50/p95 with sample counts; small samples
do not justify p99 or an SLA. Throughput is bounded sequential workload throughput,
not a demonstrated production capacity. Container resource observations are samples.

The earlier 113 ms mock visibility measurement is a different simulated workload.
The DL project's approximately 54 ms CPU / 37 ms GPU warmed forward-pipeline
medians omit network and application stages. Neither is trained application
end-to-end latency.

## Scientific and use limitations

The frozen 722-image ROI holdout reported 44.17% AP50 and 27.19% AP50:95 under
the DL study conditions. Those figures do not measure arbitrary uploads or the
integrated application. Scores are uncalibrated; false alarms, missed defects,
weak rare-class support and domain shift remain. Human corrections are illustrative
and require expertise. There is no online learning or retraining from review data.

Project code licensing does not replace the PCB-IND CC BY 4.0 attribution or the
release's pretrained-model/COCO terms. Consult the DL project's `docs/THIRD_PARTY.md`
and model card. This portfolio is unaffiliated with Matroid and is not validated
for production manufacturing inspection.
