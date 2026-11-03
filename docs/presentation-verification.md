# Public repository presentation and reproducibility

This follow-up improves the integrated repository's presentation and public setup.
It does not change application behavior, trained weights, thresholds, taxonomy,
queue ownership or review semantics. The v1.1 tag and its recorded measurements
remain unchanged. Current commands are in the [README](../README.md) and
[trained setup guide](real-pcb-inference.md).

## Public dependency compatibility

The application repository is public. The earlier paired DL delivery remains
private; current setup uses the already-public
[original DL repository](https://github.com/ThePhysic/visual-inspection-dl) at
`399a8da7407689a0ffd7dc9bde074600dd8dcbcc`.

An anonymous clean clone compared all 158 tracked entries with the former
`badae041458688f8743ce6d6f433f01a13451d0e` delivery. Only `README.md` and
`docs/API.md` differ. All ten serving source files, Docker/build inputs and the
complete three-file release tree are identical. The unchanged strict verifier
passed. Only the compatible checkout revision changes; identity and integrity
pins remain:

| Field | Value |
| --- | --- |
| Release | `pcb-ind-ssdlite-v1` |
| Serving source / public DL checkout | `399a8da7407689a0ffd7dc9bde074600dd8dcbcc` |
| Taxonomy / operating threshold | `pcb-ind-v4-1` / `0.20` |
| Artifact digest | `9037234654bcc190f6f5dd8cda07e70a119ba19b139b2b99118f4d9f27d7e05e` |
| Weights SHA-256 | `28271a688aa7335521bb7725423fd6ea6622f3d1964bfaed83dd97b4f0ff34d9` |
| Evaluation SHA-256 | `acc89d13a50caf389f74bc2cb200b0558fcbe6f6ead6e7f94f6e5ab5817b2dfd` |

## Verification scope

**Anonymous public end-to-end reproducibility: verified** at application source
`fdcd8cc3dd38104fd6044ee7d75734de6069df85`, branch `integration/real-pcb`.
The clean clone used the README's commands with unique Compose project names and
a free documented `WEB_PORT` to isolate test data. It first completed mock
inspection with no DL clone, then anonymously cloned the public DL repository,
checked out the exact pin, verified the build/mount paths, and completed trained
CPU inference plus eight-class API review save/reopen. No credentials, internal
checkout or private paired repository was required. All owned resources were
cleaned. [Machine-readable checkout evidence](presentation-evidence/anonymous-checkout.json).

Local environment: Windows 11 / Docker Desktop Linux engine 29.9.1, Ryzen 9
7940HS, Node 24.22.1 and pnpm 10.34.7. GitHub jobs use pinned Node 24.22.0;
the manual model job runs CPU-only on Ubuntu 24.04. No NVIDIA GPU is required.
Local regression checks exercised the edited candidate based on `848c57b`;
the anonymous reproduction and GitHub checks exercise the committed source above.

| Command or check | Environment | Outcome |
| --- | --- | --- |
| `pnpm lint` | Native Windows | Passed, zero warnings |
| `pnpm typecheck` | Native Windows | Passed |
| `pnpm test` | Native Windows | 396 unit/component tests and 24 Node guard checks passed; one existing filesystem-dependent 8.3 alias test skipped |
| `pnpm build` | Native Windows | Production build passed |
| `pnpm test:ci:integration` | Owned Docker dependencies / native Chromium | 153 MongoDB/API tests and 20 browser tests passed |
| `pnpm test:reliability --browser` | Owned five-service Docker stack | Passed serial rerun, including both container browser scenarios and the existing interruptions, persistence and storage safeguards |
| `pnpm test:real:smoke --ci-mongodb --recovery --keep` | Public DL clone / owned CPU stack | All seven checks passed, including real worker inference, all eight review classes, explicit mock identity, exact source/mount checks and timeout recovery; retained resources were cleaned after browser verification |
| Existing trained browser test, `--grep 'released CPU model:'` | Native Chromium / actual public-pin model | One full workflow passed: relabel/reject/manual additions, ambiguous save retry, two-tab revision conflict and history reopening |
| README mock command, then optional real command | Anonymous clean public sibling clones | All five reproduction checks passed; standard mock startup needed no DL clone |
| Public GitHub README rendering | Fresh anonymous Chromium context | All eight checks passed: title, loaded visible authentic image, badge target, clone command, mode/attribution text and capture links |
| Public source, attribution and model-term links | Anonymous HTTPS | All 14 targets returned HTTP 200 |
| Source integrity / secret preflight | Git / read-only network-disabled Gitleaks container | Existing application, Compose, CI and strict verifier unchanged; 36 candidate-history commits scanned, zero findings; original v1.1 tag and eleven historical artifacts preserved |
| Manual `Real model CPU smoke` workflow | GitHub Actions, Ubuntu CPU | [Passed on the exact source revision](https://github.com/ThePhysic/visual-inspection-platform-pcb/actions/runs/41575978539) |
| Ordinary `CI` workflow | GitHub Actions | [Passed on the exact source revision](https://github.com/ThePhysic/visual-inspection-platform-pcb/actions/runs/41575947730): Windows/Linux validation, integration and container/reliability jobs all succeeded |

One initial concurrent browser invocation failed with missing Playwright trace
files because two runners shared `apps/web/test-results`. The serial reliability
rerun passed without changing application code, assertions or test coverage.
Native Windows also emits the existing `NO_COLOR` / `FORCE_COLOR` warning.
No test failures are hidden as skips. Full DL training/evaluation and the 30+20
benchmark workload were not rerun for presentation polish; their existing records
are preserved, and no new accuracy or latency result is claimed.

Supporting records: [public dependency comparison](presentation-evidence/public-dl-compatibility.json),
[local real smoke and recovery](presentation-evidence/local-real-smoke.json),
[rendered README](presentation-evidence/readme-render.json),
[public links](presentation-evidence/public-links.json), and
[source/evidence integrity](presentation-evidence/source-integrity.json).
[GitHub run identities and conclusions](presentation-evidence/github-checks.json)
record the ordinary and manual workflows separately. All relative targets in the
edited Markdown resolve and fenced code blocks are paired.
The historical [acceptance report](real-inference/REPORT.md) remains v1.1 evidence.

Ordinary GitHub [CI](../.github/workflows/ci.yml) validates the application on
Windows and Linux, real MongoDB/API/browser interactions, container reliability
and a bounded benchmark-harness smoke. It does not run trained-model acceptance.
The separate manual [CPU smoke](../.github/workflows/real-model-smoke.yml) checks
the exact public DL pin, trained readiness and a real worker prediction without
the 30 API / 20 browser measurement workload.

## Presentation and remaining decisions

The README leads with real HTTP inference, durable execution, immutable model
predictions and revisioned eight-class human review, while retaining the independent
simulated quick start. Its trained capture is the existing authentic training-set
serving fixture; human corrections are illustrative. The original performance
figures retain sample sizes and polling boundaries. No new model evaluation or
latency claim is part of this update.

No repository visibility change, branch rename, new GitHub Release or license
decision is included. There is no whole-repository license. PCB data attribution
and pretrained-model terms remain separate. Renaming the default branch to `main`
and selecting an application license remain optional owner decisions.
There are no outstanding required publication blockers for the tested public
setup. The project retains the documented scientific and trusted-local-use limits.

## Changed files

The source changes are commits `7517a56` (public pin and manual smoke) and
`fdcd8cc` (presentation and setup). The subsequent verification commit contains
only this completed record and the evidence files listed below.

- `README.md`
- `docs/demo.md`
- `docs/portfolio-summary.md`
- `docs/real-pcb-inference.md`
- `docs/real-inference/REPORT.md` (forward-looking publication note only)
- `docs/real-inference/REAUDIT.md` (forward-looking publication note only)
- `docs/presentation-verification.md`
- `infra/real/compatibility.json` (only the compatible DL checkout revision)
- `infra/real/smoke.mjs`
- `.github/workflows/real-model-smoke.yml`
- `package.json` (one optional verification command)
- `docs/presentation-evidence/public-dl-compatibility.json`
- `docs/presentation-evidence/anonymous-checkout.json`
- `docs/presentation-evidence/local-real-smoke.json`
- `docs/presentation-evidence/readme-render.json`
- `docs/presentation-evidence/public-links.json`
- `docs/presentation-evidence/source-integrity.json`
- `docs/presentation-evidence/github-checks.json`

Recommended recruiter framing is the implemented boundary: versioned PyTorch
predictions cross a validated HTTP schema into recoverable durable execution,
then become immutable originals beneath concurrency-safe human review.
