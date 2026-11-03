# Portfolio summary

## Project positioning

Visual Inspection Platform — Real PCB Inference Integration connects a released
PyTorch detector to a durable TypeScript application and revisioned human review.
A Node worker calls an internal FastAPI CPU service, validates model provenance
and geometry, then commits immutable original predictions. Reviewers can correct
all eight PCB classes, save a separate review and reopen it from history.

The default deterministic simulated demo remains independently runnable with five
services, two mock classes and no DL clone. Trained mode is an explicit opt-in for
identified 300×300 PCB candidate patches, with no silent mock substitution during
a model outage. This is a local portfolio project, not a production inspection
product or whole-board diagnosis.

**Stack:** React, TypeScript, Vite, React Router, TanStack Query, react-konva;
Node/Fastify, TypeBox, MongoDB/Mongoose, Redis/BullMQ, Sharp; Python/FastAPI and
PyTorch in the independent DL repository; Docker Compose/nginx, Pino,
Vitest/Testing Library, Playwright and GitHub Actions.

## Engineering decisions worth discussing

1. **MongoDB-first acceptance:** queued documents carry dispatch intent.
   Post-response dispatch optimizes scheduling; startup/periodic reconciliation
   repairs missed work without making Redis a prerequisite for durable acceptance.
2. **At-least-once attempts with conditional authority:** generation-specific queue
   IDs, persistent attempt budgets, expiring leases and database-time ownership
   checks prevent stale attempts from replacing a committed result.
3. **Cross-language provenance validation:** canonical bytes reach a pinned Python
   release over HTTP. The adapter checks backend, model, taxonomy, release digest,
   labels, dimensions and boxes rather than trusting a simulated flag alone.
4. **Separate prediction and review data:** original predictions remain unchanged;
   a complete review snapshot uses revision/write-sequence checks and bounded
   operation receipts for conflict handling and ambiguous-response retries.
5. **Canonical geometry:** EXIF orientation is applied before storage. The adapter,
   responsive canvas and persistence share normalized image coordinates without
   rounding original model boxes.
6. **Independent repositories:** this repository owns application behavior and
   optional deployment configuration; the [DL repository](https://github.com/ThePhysic/visual-inspection-dl)
   owns training, evaluation, release artifacts and serving. No training request
   or automatic learning is triggered by an inspection or saved correction.

## Evidence and limits

- [Real CPU acceptance](real-inference/REPORT.md) records the exact revisions,
  release digest, commands, eleven real-stack checks and measurement definitions.
  [The second audit](real-inference/REAUDIT.md) records reproduced edge cases and
  regression fixes, including expired leases and actual busy/timeout recovery.
- Recorded concurrency-one API observations: upload through trained completion
  p50/p95 **155.08/274.80 ms**, **n=30**, 100 ms polling, four attributed patches.
  Browser-visible completion was **2429.97/2441.18 ms**, **n=20**, 2 s polling,
  repeating a training-set serving fixture. Neither distribution establishes an SLA.
- [Reliability evidence](reliability.md) covers dependency interruptions, stale
  attempts, finite retries and container recreation. It distinguishes observed
  recovery from exactly-once or disaster-recovery guarantees.
- [Historical mock optimization](performance.md#task-05c-opt-observed-results):
  median simulated-inspection visibility **4,955 → 113 ms (97.7% reduction)**
  after prompt dispatch, with eight matched local samples and 100 ms polling.
  This is a differing simulated workload, not trained-model acceleration.
- GitHub's default CI checks application correctness on Ubuntu and Windows plus
  integration/browser/container behavior. Full trained-model acceptance and its
  timing workload are separately recorded local evidence, not ordinary push CI.
- The model's frozen ROI holdout evaluation does not measure arbitrary images or
  application accuracy. Scores are uncalibrated; false alarms, misses and weak
  rare-class support remain. The project is unaffiliated with Matroid and is not
  validated for production manufacturing inspection.

## Résumé bullet candidates

- Integrated a released PyTorch PCB detector with a TypeScript/Fastify application
  through a private FastAPI service, strict cross-language response validation,
  immutable model provenance and eight-class human review.
- Implemented a MongoDB-first Redis/BullMQ pipeline with idempotent acceptance,
  bounded retries and lease-fenced commits; verified model busy/timeout recovery,
  worker interruptions and persisted review conflicts with disposable test stacks.
- Built a React/Konva correction workflow that preserves original predictions
  while saving revisioned annotations and reopening them through filtered history.

Use linked evidence and its scope in interviews. Do not claim production adoption,
commercial users, calibrated defect probabilities, whole-board search, cloud scale,
exactly-once execution, or an inference speedup from the historical mock benchmark.

## Repository presentation

Suggested repository description:

> Released PCB inference with a durable TypeScript queue, strict model provenance, immutable predictions and revisioned human review; independent simulated demo included.

Suggested topics: `typescript`, `react`, `fastify`, `mongodb`, `redis`, `bullmq`,
`pytorch`, `fastapi`, `docker-compose`, `computer-vision`, `human-in-the-loop`.

The README's current CI badge points to
`ThePhysic/visual-inspection-platform-pcb` and its `integration/real-pcb` default
branch. The [original SWE repository](https://github.com/ThePhysic/visual-inspection-platform)
is linked as upstream context, not as the integrated quick-start clone target.
Description, topics, branch names and visibility are owner-controlled settings;
documentation changes do not silently change them.

**License:** no whole-repository license has been selected, and public visibility
does not grant a project-wide redistribution license. PCB-IND fixture attribution
and pretrained-model terms remain separate; consult the
[fixture manifest](../fixtures/pcb/README.md) and the DL project's third-party
documentation. No license file is added by this presentation work.

Use the [demo scripts](demo.md) and authentic trained-result/review/history captures
linked from the README. No hosted application or video is claimed.
