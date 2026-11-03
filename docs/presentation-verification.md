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

Validation of this presentation revision is in progress. Results will be recorded
here before handoff. The historical [acceptance report](real-inference/REPORT.md)
is evidence for v1.1, rather than a claim that new checks or measurements ran.

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
