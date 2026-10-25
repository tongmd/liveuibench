# LiveUIBench

[arXiv paper](https://arxiv.org/abs/2610.27977) · [BibTeX](../citation.bib)

**500 cases: 328 dev + 172 public test**, with the original 230 initial-world fixtures. The original 319 objects and fixtures are unchanged; 181 authored development variants add note, file, task and alarm workflows. The additions are unmeasured development data, not a new held-out test set. Their literal entities are created by their current messages rather than assumed to exist in a dedicated fixture. Each workflow generates an app, opens it, submits data, revises a request, and reopens saved state. Sealed test cases are excluded.

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

For the full bundled dataset, use `--split all --limit 500`. Choose a new output directory for every run.

Each case owns a runtime process, SQLite database, app registry, AppWorld instance, ports, and evidence directory. Episode groups within a case share its world. The runner bounds concurrency, retains failures, and stops its worker processes on completion or cancellation. Managed parallel evaluation supports **LiveUIAgent (`native`) only**.

## Evaluators and metrics

| Result | Definition |
| --- | --- |
| `fullWorkflowRate` | Cases passing every scripted assertion / all selected cases |
| `assertionPassRate` | Passed scripted assertions / all planned assertions |
| `executedCasePassRate` | Passing cases / executed cases, excluding explicit skips |
| GUI evaluation | Actual product A2UI renderer in Chrome for live Native delivery; Chrome iframe DOM and geometry checks for HTML delivery; structural checks only for offline mock |
| Behavior evaluation | Additional interactions and model-based judgments, reported separately |

`--evaluator both` runs GUI and behavior evaluation. Use `gui` or `behavior` to select one. `--skip-agent-evaluator` omits model-driven behavior evaluation. Diagnostics run after all scripted groups and do not change workflow scores. Live Native GUI reports identify the product renderer source SHA and actual DOM checks; these do not measure human visual preference. Behavior-only evaluation uses the existing direct Native action route and explicitly reports that GUI was not assessed. A scripted action is counted as a GUI interaction only when the driver fills an unambiguous natural-language request field and clicks its ordinal-bound control. Multiple structured inputs or an unclear input meaning fail as unsupported without sending an action; the runner does not invent field values or substitute a direct HTTP action and call it a UI click.

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

The runner selects the actual delivered surface from the execution delivery declaration and package structure, independently of the requested inference harness. A DSH-backed Native package retains `harness: "dsh"`, the requested model, and its Native `/agent/action` / `/agent/query-state` lifecycle. Conflicting delivery metadata or missing Native renderer resources fail. HTML artifact replay is explicitly limited to diagnostic HTML delivery.

For HTML delivery, the driver opens the generated HTML in Chrome, interacts with visible controls, and reloads persisted state. A sole text input accepts the full action message; multi-field forms require explicit visible-label/value mappings, and ambiguous interactions fail without submitting. DSH audit checks consume host-produced evidence from the current browser action. A completed `/agent/complete/apps/:id/action` job may return `evidence` with `schemaVersion: 1`, the exact external `appId`, and `trace`, `toolResults`, and `toolDbChanges` in the native scorer's format. The job must include its `id` and `status: "done"`. These fields must come from server-side execution and simulator database observations; model-generated `result` content is never audit evidence. Missing evidence fails its assertion. Workflow-route checks still require executable package workflow metadata; an HTML button alone does not establish a route. DSH runs remain diagnostic until per-case runtime/world isolation is established and cannot be compared directly with managed native workflow scores.

Dataset revise episodes are action turns. To test app code revision separately, add `--revision-prompt "Improve the layout while preserving my records"`.

## Offline checks

```sh
npm run test:liveuibench
npm run bench:liveui -- --mock
```

These use dedicated fixtures without model calls or AppWorld. Reports are marked `mode: "mock"` and `comparable: false`.

Artifact replay is a separate DSH diagnostic mode. Seal a completed case with `python3 scripts/liveuibench/artifact-replay-seal.py --case-root CASE_ROOT --dataset DATASET --account-root DSH_DATA --generation-source-manifest SOURCE_MANIFEST --out SEALED_DIR`, then pass `--artifact-replay CONFIG.json` to the same one-case live DSH command above. The configuration supplies `caseId`, `manifestRoot`, `manifestSha256`, `importer`, `importerSha256`, `ownerPrefix` (a unique `artifact-replay-RUNID-` namespace), `accountRoot`, `runtimeDb`, and `receiptDir` as isolated management paths. The sealer requires the original first browser-delivery snapshot to match the generation output; missing groups remain unavailable and retain their evaluation denominator.

Replay imports byte-identical delivered HTML into a new owner with empty stores and original scoped service plans. All available groups are registered before the runtime first loads that owner, so this is not the original sequential generation protocol and is never comparable. Reports explicitly identify reused artifacts, the source manifest, and zero generation-model calls for replay. Original generation costs remain separate; replay's real native actions can still incur model/API calls and business mutations. Runtime package loading, browser interaction, and the original business assertions still execute normally.


## Agent Memory and personalized interfaces

`longitudinal.json` contains 28 authored development cases: 16 Agent Memory cases and 12 personalized-interface cases. The original 319 case objects, fixtures, and scorer remain unchanged; the core file also includes 181 later authored development variants. It does not establish a held-out test set or measured model performance.

Each case contains ordered sessions and messages. A fresh session must reset the conversation while retaining that owner's application, records, and persistent memory. A different owner must have a distinct owner scope; a reopen must return the same application. The adapter must provide lifecycle receipts rather than treating a new session label as evidence of a reset.

Each case has its own fresh namespace. Optional session `appKey` values distinguish applications within one owner; owner memory may transfer between those applications while application state and app-scoped memory remain separate. Application identity checks and memory isolation are explicit; the cross-app probes reuse synthetic record content and do not alone establish comprehensive database isolation.

The Agent Memory track covers remembering and applying preferences, corrections, temporary overrides, scoped forgetting, isolation, and untrusted document content. A stored preference alone is insufficient: the task also checks its visible consequence or preserved application records. The personalized-interface track changes the actual interface, checks observable controls or computed styles, and checks that records and existing controls survive. These checks cover stated requirements; they do not claim comprehensive visual quality or all business workflows.

```bash
npm run bench:longitudinal -- --dataset benchmarks/longitudinal.json --validate
npm run bench:longitudinal -- --dataset benchmarks/longitudinal.json \
  --adapter ./path/to/your-adapter.mjs --out artifacts/longitudinal/report.json
```

Adapters execute only the current message and lifecycle operation. Future messages and assertions must not enter model context. Observations come from the memory store, normalized durable application state, and real browser DOM/computed styles. The normalized `state.records` view is an adapter contract, not a mandated application storage schema. CSS selectors address accessible controls and labels requested in the visible task. Missing observations, unsupported operations, and failed lifecycle receipts fail closed; claiming a preference or returning a screenshot description is not a DOM observation.

The reset and reopen receipts are adapter claims and require an independent live-adapter audit. The observer receives only the keys/selectors needed for readback; it must be read-only and its requests must never be fed back into generation or used to alter memory or the interface. These are constrained accessibility development probes: their visible instructions request the exact ARIA names used by selectors, not hidden test IDs. Retaining a visible control does not prove that its business operation still works.

No built-in live-runtime adapter is included in this task-set release. An adapter must actually implement session reset, memory-store reads, application reopening, owner isolation, and browser observation before reporting live results. Fixture tests check protocol mechanics only. Reports distinguish fixture from real execution, retain unexecuted assertions in the denominator, and never establish comparability with the original benchmark. Memory-enabled versus disabled comparisons require independent fresh worlds and the same task sequence; removing memory while leaving the original conversation or cached application preferences intact is not a valid memory ablation.

The development prompts contain explicitly authored synthetic records and preferences. They are not recovered private user histories, and the data files contain no experiment outcomes. `longitudinal-provenance.json` records the release contents and hashes.


## Source-bound expansion

`liveuibench-expanded.json` preserves every original case and appends continuations to each original intention group: 517 memory continuations and 517 personalized-interface continuations. The 17 shared-world cases retain all application mappings. These are 1,034 continuations of 500 source cases, not 1,034 new independent base tasks or additional held-out samples. Existing development/public-test splits are inherited; authoring used the released source tasks, so the expanded public-test portion is not a newly sealed test set.

The generator `scripts/longitudinal/expand-source.mjs` records source dataset bytes and per-case/per-intention hashes. The expanded dataset keeps all original prompts, expected behaviors, episodes, and assertions unchanged. Original workflow checks and continuation checks have separate reports and denominators.

```bash
node scripts/longitudinal/expand-source.mjs
npm run bench:expanded -- --validate
npm run bench:expanded -- --case spotify-weekly-commute-playlist \
  --adapter ./your-audited-adapter.mjs --out artifacts/expanded.json
```

`bootstrapOriginal` must execute the complete original case using the original business driver in a fresh isolated namespace. Its receipt binds the source hash, every ordered original episode, the owner, world, intention-to-app mapping, and original report. Each selected continuation receives its own fresh original workflow execution; do not replay mutations after an unresolved request or copy old generated HTML. Original failure is reported and blocks the continuation. A missing original driver is unsupported, retaining the planned continuation denominator.

After bootstrap, every conversation and reopen must retain that owner, world and target app. Only the current message is sent through `act`; no future instructions or assertions are model inputs. `bootstrapOriginal` is a trusted evaluation-driver interface and its gold assertions must remain outside agent context. A live adapter must be independently audited; receipts alone do not prove real-world correctness.

The observer reads persistent records, scoped memory, runtime action identities, and actual computed browser styles. Semantic selectors `@source.primaryRecords` and `@source.primaryActions` must map to the original application's genuine main records and actions, never added hidden test containers. Baseline records cannot be silently omitted; preserved actions must retain their runtime identity. Visible action retention does not prove all business operations remain functional. Style restoration is compared with the original baseline, without prescribing the implementation's private preference schema.

No built-in live adapter currently bridges the original business runner and these continuations. This release supplies expanded data, validation, and a fail-closed adapter protocol, not measured model performance. Do not pool these scores with the original protocol or claim full long-horizon, autonomous-memory, or UI quality coverage from these explicit preference tasks.
