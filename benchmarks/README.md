# LiveUIBench

[arXiv paper](https://arxiv.org/abs/2610.27977) · [BibTeX](../citation.bib)

**319 cases: 147 dev + 172 public test**, with 230 initial-world fixtures. Each workflow generates an app, opens it, submits data, revises a request, and reopens saved state. Sealed test cases are excluded.

## Parallel evaluation

Install AppWorld and its data, run `npm run build`, and export `OPENAI_API_BASE`, `OPENAI_API_KEY`, and any model routes. Workers use fresh state and read credentials from the parent process environment.

```sh
npm run bench:parallel -- \
  --workers 2 \
  --appworld-bin /absolute/path/to/appworld \
  --appworld-root /absolute/path/to/appworld-data \
  --harness native --model YOUR_MODEL \
  --split dev --limit 2 --evaluator both \
  --out artifacts/liveuibench/native-dev
```

For the full bundled dataset, use `--split all --limit 319`. Choose a new output directory for every run.

Each case owns a runtime process, SQLite database, app registry, AppWorld instance, ports, and evidence directory. Episode groups within a case share its world. The runner bounds concurrency, retains failures, and stops its worker processes on completion or cancellation. Managed parallel evaluation supports **LiveUIAgent (`native`) only**.

## Evaluators and metrics

| Result | Definition |
| --- | --- |
| `fullWorkflowRate` | Cases passing every scripted assertion / all selected cases |
| `assertionPassRate` | Passed scripted assertions / all planned assertions |
| `executedCasePassRate` | Passing cases / executed cases, excluding explicit skips |
| GUI evaluation | Structural checks for native apps; Chrome DOM and geometry checks for HTML apps |
| Behavior evaluation | Additional interactions and model-based judgments, reported separately |

`--evaluator both` runs GUI and behavior evaluation. Use `gui` or `behavior` to select one. `--skip-agent-evaluator` omits model-driven behavior evaluation. Diagnostics run after all scripted groups and do not change workflow scores. Native GUI checks are structural proxies; they do not measure human visual preference.

Generation and preparation errors retain all planned assertions as failures. Unsupported assertions fail. Reports include configuration, preparation evidence, responses, and per-case results. Evaluator calls can incur additional model usage.

Fixtures initialize the simulator. Expected assertions, future messages, and audit metadata are excluded from generation. Fixture contacts are excluded by default; `--fixture-contacts` enables an assisted diagnostic run. Comparable runs require unassisted native execution with managed per-case isolation. Mock, serial, shared-gateway, and DSH runs are diagnostic.

## Serial evaluation

For a dedicated server with an already prepared AppWorld case:

```sh
npm run bench:liveui -- \
  --harness native --model YOUR_MODEL \
  --api-base http://127.0.0.1:8787 \
  --split dev --only spotify-weekly-commute-playlist --limit 1 \
  --world-mode prepared --evaluator both \
  --out artifacts/liveuibench/native-one
```

Enable AppWorld in `liveuiagent/liveuiagent.config.json` and set `APPWORLD_API_BASE` on the server. The managed runner configures the published fixture identity automatically; use it for fixture-backed comparable runs. Keep grounding enabled. `prepared` accepts one case; `unmanaged` uses existing world state. Neither establishes per-case isolation. Authenticated access uses the `LIVEUIBENCH_AUTHORIZATION` environment variable.

For automatic serial preparation, pass `--prepare-hook "$PWD/scripts/liveuibench/prepare-appworld.mjs"` and export `LIVEUIBENCH_APPWORLD_BIN`, `LIVEUIBENCH_APPWORLD_ROOT`, and `LIVEUIBENCH_APPWORLD_PORT`. Point the dedicated server's `APPWORLD_API_BASE` at that port. The hook resets and seeds its own world once per case; it must never target a shared production world. Serial hook processes remain running until explicitly stopped; their PID is recorded under `artifacts/appworld-PORT/process.json`.

## DeepSeek Harness

```sh
npm run bench:liveui -- \
  --harness dsh --model YOUR_MODEL \
  --api-base http://127.0.0.1:8787 \
  --split dev --limit 1 --world-mode unmanaged --evaluator both \
  --chrome /absolute/path/to/chrome \
  --out artifacts/liveuibench/dsh-one
```

The driver opens the generated HTML in Chrome, interacts with visible controls, and reloads persisted state. A sole text input accepts the full action message; multi-field forms require explicit visible-label/value mappings, and ambiguous interactions fail without submitting. DSH audit checks consume host-produced evidence from the current browser action. A completed `/agent/complete/apps/:id/action` job may return `evidence` with `schemaVersion: 1`, the exact external `appId`, and `trace`, `toolResults`, and `toolDbChanges` in the native scorer's format. The job must include its `id` and `status: "done"`. These fields must come from server-side execution and simulator database observations; model-generated `result` content is never audit evidence. Missing evidence fails its assertion. Workflow-route checks still require executable package workflow metadata; an HTML button alone does not establish a route. DSH runs remain diagnostic until per-case runtime/world isolation is established and cannot be compared directly with managed native workflow scores.

Dataset revise episodes are action turns. To test app code revision separately, add `--revision-prompt "Improve the layout while preserving my records"`.

## Offline checks

```sh
npm run test:liveuibench
npm run bench:liveui -- --mock
```

These use dedicated fixtures without model calls or AppWorld. Reports are marked `mode: "mock"` and `comparable: false`.

Artifact replay is a separate DSH diagnostic mode. Seal a completed case with `python3 scripts/liveuibench/artifact-replay-seal.py --case-root CASE_ROOT --dataset DATASET --account-root DSH_DATA --generation-source-manifest SOURCE_MANIFEST --out SEALED_DIR`, then pass `--artifact-replay CONFIG.json` to the same one-case live DSH command above. The configuration supplies `caseId`, `manifestRoot`, `manifestSha256`, `importer`, `importerSha256`, `ownerPrefix` (a unique `artifact-replay-RUNID-` namespace), `accountRoot`, `runtimeDb`, and `receiptDir` as isolated management paths. The sealer requires the original first browser-delivery snapshot to match the generation output; missing groups remain unavailable and retain their evaluation denominator.

Replay imports byte-identical delivered HTML into a new owner with empty stores and original scoped service plans. All available groups are registered before the runtime first loads that owner, so this is not the original sequential generation protocol and is never comparable. Reports explicitly identify reused artifacts, the source manifest, and zero generation-model calls for replay. Original generation costs remain separate; replay's real native actions can still incur model/API calls and business mutations. Runtime package loading, browser interaction, and the original business assertions still execute normally.
