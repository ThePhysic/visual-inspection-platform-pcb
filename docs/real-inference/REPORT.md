# Real PCB integration acceptance report

Status: validation in progress. This file will record executed outcomes before
delivery; the presence of a runner is not evidence that a scenario passed.

## Revision and release scope

- Platform baseline: `e7463b8cf7af03505185cfd5c03e839fcd151406`.
- Integration source: `32b688fe97093629647eb10e5ca69c3ccbc982ab`, followed by
  measurement evidence refinement `f33d746`.
- DL compatible checkout: `e1e84e2eac9c91e5bd8021aea20a6ec712616285`; serving
  source `399a8da7407689a0ffd7dc9bde074600dd8dcbcc`.
- Released model: `pcb-ind-ssdlite-v1`, taxonomy `pcb-ind-v4-1`, threshold `0.20`.
- Artifact digest: `9037234654bcc190f6f5dd8cda07e70a119ba19b139b2b99118f4d9f27d7e05e`.
- Full pins and weight/evaluation hashes: [compatibility.json](../../infra/real/compatibility.json).

## Executed checks

| Command | Observed outcome |
| --- | --- |
| `pnpm typecheck` | Passed across contracts, backend, API, worker and web |
| `pnpm lint` | Passed, zero warnings |
| `pnpm test` | 381 tests passed; one existing filesystem-dependent 8.3 alias test skipped; benchmark-core 10 passed |
| `node --test infra/real/environment.test.mjs` | 3 ownership/mount guard tests passed |
| `pnpm test:ci:integration` | Initial API/Mongo run: 149 passed. Initial browser run could not launch because pinned Chromium was absent; browser installation and rerun in progress |
| `pnpm test:reliability` | In progress |
| `pnpm test:real --ci-mongodb` | Pending |
| DL `.venv-cpu/Scripts/python.exe -m ruff check .` | Passed |
| DL `.venv-cpu/Scripts/python.exe -m ruff format --check .` | 29 files already formatted |
| DL `.venv-cpu/Scripts/python.exe -m pytest -q --tb=short` | 214 passed, 15 dependency deprecation warnings, 83.22 seconds |
| `node infra/real/verify-release.mjs` | Exact DL checkout and released weight/evaluation hashes verified |
| DL `docker build --tag vip-pcb-integration-dl:cpu .` | Existing CPU Dockerfile built successfully |

Windows sandbox permissions prevented Docker/keyring access, generated-file writes,
child-process spawning and pytest temporary-directory use on initial attempts.
The same checks were rerun with tool-approved access. No assertion was removed
to work around an environment restriction.

## Measurement environment and interpretation

Host: AMD Ryzen 9 7940HS, 8 cores / 16 logical processors; Windows 11 Home
10.0.26200, approximately 32 GiB RAM. Docker Desktop Linux engine 29.9.1 on
WSL2 kernel `6.18.54.1-microsoft-standard-WSL2`, 16 logical CPUs and approximately
15.2 GiB available to the engine. Native Node 24.22.1, pnpm 10.34.7; application
containers pin Node 24.22.0. DL uses Python 3.12.15, Torch 2.7.1+cpu,
TorchVision 0.22.1+cpu and four Torch CPU threads. No GPU is requested or used.

The real runner records actual container/resource observations and revisions in
`acceptance.json`. It separates image/upload acceptance, durable inspection
creation, queue wait, HTTP inference/JSON decoding, Python stages, result commit,
API-observed completion (100 ms polling), and browser visibility (2 s polling).
First prediction after readiness excludes process/bundle startup; whole-stack
creation-through-health is a separate observation, not pure model-loading time.

Thirty sequential API workflows cycle four attributed 300×300 patches. Twenty
sequential browser workflows repeat the training-set serving fixture. These are
different workload definitions. Nearest-rank p50/p95 describe the recorded samples;
there is no p99, calibrated accuracy, production-capacity or SLA claim. Resource
samples are point observations, not peak measurements. The existing unrelated
PostgreSQL container remains running on the host.

The original 113 ms mock visibility benchmark and the DL warmed Python-only
54 ms CPU / 37 ms GPU measurements do not represent this integrated workload.

## Evidence and limitations

The real runner must generate actual Python responses, browser captures, timing
samples, outage/retry and restart evidence before this report records a pass.
Review edits in the demonstration illustrate UI operations and are not expert
adjudication of PCB ground truth. The sample attribution and audited split
provenance are in [fixtures/pcb](../../fixtures/pcb/README.md).

Input admission combines canonical 300×300 geometry with explicit human domain
attestation. It does not automatically recognize whether pixels depict a PCB.
No whole-board search, tiling, online learning or retraining is included.
The model's 44.17% AP50 and 27.19% AP50:95 apply to the DL frozen 722-image
holdout study, not this application. Scores are uncalibrated; false alarms,
missed defects and weak rare-class support remain. The project is unaffiliated
with Matroid and is not validated for production manufacturing inspection.

Astra medium adversarial review and private publication are pending.
