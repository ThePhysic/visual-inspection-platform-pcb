# Two-to-three-minute demonstrations

Choose the trained PCB path below to show the integration, or the independent
simulated path to explain the baseline application. These are scripts and links
to authentic captures; no video is claimed.

## Trained PCB path

Start the pinned CPU stack using the [real-mode guide](real-pcb-inference.md).
Have `fixtures/pcb/5810_t_007.jpg` ready. It is a PCB-IND v4 **training-set serving
fixture**, not a holdout evaluation sample; retain the
[source, license and split attribution](../fixtures/pcb/README.md).

| Time | Browser action | Suggested narration |
| --- | --- | --- |
| 0:00–0:25 | Show the two modes; check availability, select **Trained PCB detector** and the candidate patch; confirm its domain | “The default is a separate simulated demo. This mode calls a pinned released CPU model for an identified 300×300 PCB candidate patch.” |
| 0:25–0:50 | Upload and inspect; show the trained badge, version, taxonomy and digest | “MongoDB accepts durable intent, and a Node worker calls the private Python service. Failure retries are bounded and never substitute mock predictions.” |
| 0:50–1:15 | Show original boxes, classes and scores | “These are candidate-patch predictions, not a full-board diagnosis. Scores are uncalibrated, and false positives and missed defects remain.” |
| 1:15–1:55 | Enter review; reject one prediction, relabel another or add a missed region | “All eight classes support correction. Each original prediction is retained as accepted or rejected; manual additions have no invented confidence. These edits illustrate the controls, not expert ground truth.” |
| 1:55–2:25 | Save; refresh; reopen through history | “The review has its own revision. Saved corrections survive reopening while original predictions and release identity stay unchanged.” |
| 2:25–2:45 | Show original predictions again and link the acceptance report | “The recorded tests cover busy responses, timeouts, retries and restart persistence. The application does not retrain itself from these edits.” |

Reference captures: [trained result](real-inference/trained-result.png),
[saved review](real-inference/trained-review.png), [upload](real-inference/trained-upload.png)
and [history](real-inference/trained-history.png). The
[acceptance report](real-inference/REPORT.md) defines measurement boundaries.
Use isolated existing recovery tests for an optional outage demonstration; do
not interrupt personal demo services or imply an outage always fits this script.

## Simulated path — prepare

Use the README Docker-only startup command and open http://127.0.0.1:8080.
Check `docker compose -p vip-demo ps` and complete one inspection before recording.
Use a fresh intentional inspection, not an existing dirty draft. Never delete
personal demo volumes to make a recording look clean. A dedicated new Compose
project/unused loopback port is preferable if you need an empty history.

Have `fixtures/inspections/machined-panel.png`, `edge-component.png` and
`clean-panel.png` ready in the file picker. They are original **illustrations**,
not photographs or manufacturing evidence. See [provenance and prediction map](../fixtures/inspections/README.md).

## Simulated path — run of show

| Time | Browser action | Suggested narration |
| --- | --- | --- |
| 0:00–0:15 | Show upload page and simulated-inference notice | “This is a full-stack inspection and human-review workflow. The detector is deterministic and simulated; I built the software around it.” |
| 0:15–0:35 | Select `machined-panel.png`; choose **Upload and inspect** | “The API validates and auto-orients the image, saves canonical bytes and metadata, then durably accepts an asynchronous inspection.” |
| 0:35–0:55 | Show completed overlay, labels, scores and provider metadata | “A separate BullMQ worker returns curated mock output. Scores do not represent real defect accuracy. Prompt dispatch is backed by periodic recovery.” |
| 0:55–1:20 | **Edit local draft**; select annotation 1; change **Edge defect** to **Surface mark**; drag the box and resize with a corner handle | “The first region is intentionally mislabelled. Corrections use normalized canonical-image geometry; original predictions remain immutable.” |
| 1:20–1:40 | Select annotation 3 over the top-left bolt; **Reject prediction**. Select **Surface mark** for new annotation; **Add annotation**; draw around the two small lower-right marks | “This bolt is an intentional false positive. Rejection preserves its prediction reference. A manually added object has no fabricated model confidence.” |
| 1:40–2:00 | **Save review**; show revision 1 and no unsaved changes; refresh | “The complete review snapshot is stored separately. Revision checks prevent silently overwriting a newer tab, and save-operation identity handles ambiguous network retries.” |
| 2:00–2:20 | Reopen via **History**, filter **Completed**, select the saved-review card | “History uses server-side filtering and cursor pagination; links reopen persisted corrections.” |
| 2:20–2:45 | Optionally upload `clean-panel.png` or show an already-created portrait result | “Zero detections is valid. Portrait geometry uses the same coordinate system. The deployment is a five-service local Compose stack.” |

The mock may complete before a queued/processing frame is visible. Do not add an
artificial provider delay, edit the page, or claim the UI waited for a model.
Explain asynchronous execution using the architecture diagram or actual worker
logs. The browser polls every two seconds; the benchmark's polling is 100 ms.

The missed region is around canonical pixels `(780,520)` to `(864,576)`.
Predicted boxes are loose by design; the demonstration is about editing behavior,
not a ground-truth labelling protocol. Rejected boxes disappear from the canvas
but stay discoverable in the annotation list.

## Recording checklist

- Record a real browser at 1440×1100 or comparable desktop resolution and readable
  zoom. Hide personal tabs, notifications, credentials and unrelated folders.
- Capture actual pointer dragging, resize handles, drawing, save confirmation,
  browser refresh and history reopening. Keep the chosen mode's badge visible.
- Use a real screen recorder; capture microphone narration if helpful. No recording
  was created by this task. Trim only idle time; label any cuts or separate takes.
- Check audio, readability, cursor visibility and that refresh recovered the review.
- Optional second clip: two tabs opened before either saves, then save one and
  attempt the other to show 409 conflict recovery. Do not suggest real-time collaboration.
- Optional recovery clip: use the existing controlled isolated tests, never break
  personal demo services or expose fault endpoints for a recording.
- After reviewing/exporting a real recording, manually add its actual URL to the
  README. Until then use the demo scripts and authentic captures without a dummy
  video link or unfinished recording placeholder.

## Screenshots

Install native test tooling and Chromium as in [development](development.md), then:

```powershell
pnpm portfolio:capture
```

This builds a new generated, ownership-verified Compose project, exercises the
simulated application workflow, captures three PNGs, records provenance, and cleans up only its own
resources. Existing demo/native environments are not used. No HTTP responses or
Konva events are mocked. Existing private Chromium caches can be selected with
the standard `PLAYWRIGHT_BROWSERS_PATH` environment variable; ordinary installations
need no override. On affected Linux kernels add `--ci-mongodb` as documented in
[CI compatibility](ci-mongodb-compatibility.md).

Manual alternative: run the same actions above and use your browser/OS screenshot
tool for (1) original detections, (2) saved review revision 1 after refresh, (3)
completed history with canonical thumbnails. Retain the unmodified captures,
record date/source/viewport, and update `docs/screenshots/capture.json`. Never
describe a mockup or retouched screenshot as a working application capture.
