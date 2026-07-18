# GUIOS

**An agent-native application runtime.** Say one sentence, and an agent generates an app whose interface, state, and behavior it maintains — live, interactive, and genuinely usable.

GUIOS is also the reference runtime for **LiveUIBench**, a behavioral benchmark for *agent-generated* GUI workflow surfaces, described in our upcoming paper:

> **LiveUIBench: A Behavioral Benchmark for Agent-as-GUI Workflow Surfaces** (under review)
> Paper site: https://liveguibench.pages.dev/ · Project site: https://guios.pages.dev/

---

## What is GUIOS?

Most "AI builds an app" systems generate code. GUIOS generates **spec packages**: an app is a bundle of `manifest.json`, `ui.json`, `actions.json`, `data.schema.json`, `agents.json`, memory, tests, and assets — validated, versioned, diffable, and rendered by a single universal runtime on Web, iOS, and Android.

```text
User Message → App Spec → Validation → Registry → Universal Renderer → Agent Backend Actions
```

- **Whiteboard-first UX** — you type a natural-language intention into the bottom dock; a multi-agent pipeline (requirement → planner → UI → action → data → asset → safety → layout) produces an app card you can open immediately.
- **No client-side business logic** — every button, form, and list event dispatches to a unified agent gateway (`/agent/run`, `/agent/action`, `/agent/patch-app`, `/agent/query-state`, …). The frontend renders; agents act.
- **One spec, three platforms** — the same `ui.json` renders through a shared component registry on Web (Vite/React), iOS, and Android (Expo / React Native).
- **Safety by construction** — generated specs are restricted to a whitelisted component set; `script`, `iframe`, `raw_html`, `custom_js`, and shell access are forbidden; SVG assets are sanitized; actions must declare capability permissions.
- **Real-service grounding** — app actions can invoke real executable APIs (via [AppWorld](https://appworld.dev)) and write the returned entities back into visible UI state.

Architecture details (in Chinese): [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md).

## Quickstart

Requirements: Node.js ≥ 20, an OpenAI-compatible LLM endpoint.

```bash
npm install
cp .env.example .env

# LLM configuration (OpenAI-compatible)
export OPENAI_API_KEY=sk-...
export OPENAI_API_BASE=https://your-endpoint/v1
export GUIOS_ORCHESTRATOR_MODEL=<model-name>

npm run dev        # server on :8787 + Vite client
```

Open the client, type an intention (e.g. *"an app where each week I set the vibe for my commute and it builds a fresh playlist, remembering last week's picks"*), and watch the app card appear.

Other useful commands:

```bash
npm test                     # smoke test
npm run test:cross-platform  # cross-platform spec rendering checks
npm run shell:web            # Expo universal shell (also shell:ios / shell:android)
npm run build && npm start   # production build
```

Optional real-API grounding (used by the demo and the benchmark) requires a local AppWorld world:

```bash
python3 -m venv .appworld-venv
.appworld-venv/bin/pip install appworld
appworld install && appworld download data --root .
bash scripts/livegui/reset-appworld.sh   # pristine world on :9000
```

---

## LiveUIBench: the dataset

**`benchmarks/liveuibench.json`** (v0.2.0) is a hand-audited behavioral suite that asks a deceptively simple question:

> *Can an agent turn an end-user intention into a working app — one that users can open, operate, revise, and reopen, and that actually drives the real services it names?*

This differs from GUI-agent benchmarks (which **operate** existing software) — here the agent must **create** the environment that later interactions operate.

### Composition

| | |
|---|---|
| Cases | **140 released** (65 dev / 75 public test); a 79-case sealed test split is withheld for hosted evaluation and contamination control |
| Splits | **65 dev / 75 public test**, stratified by domain (+ 79 sealed, withheld) |
| Domains | 11 AppWorld app domains: spotify, amazon, gmail, phone, venmo, splitwise, todoist, simple_note, file_system + 2 cross-app |
| Episodes | 4 per core case, fixed order: **open → submit → revise → reopen** (448 in the released splits; 764 in the full suite) |
| Assertions | **2,172 deterministic assertions** in the full suite (1,265 released) — no LLM judge in scoring |
| World fixtures | seedable world fixtures for precondition-dependent cases (80 released) |

Each case carries a natural-language intention, e.g.:

> *"I want an app where each week I set the vibe for my drive to work and it builds a fresh commute playlist, remembering what I picked last week so I can tweak it instead of starting over."*

and episode-level user messages with deterministic assertions checked against execution traces, per-action API-call records, and before/after database diffs (counts below are for the full 219-case suite):

| Assertion type | Count | Checks |
|---|---|---|
| `route_enters_orchestrator` | 382 | UI events reach the agent workflow |
| `visible_result_grounded` | 382 | the concrete returned entity becomes visible state |
| `appworld_api_called` | 376 | the *named* real API is actually invoked |
| `appworld_db_changed` | 268 | the application database changes |
| `input_available` / `action_available` / `route_exists` / `state_persists` | 191 each | first-screen affordances & reopen persistence |

### Five executable contracts

A case is **resolved** only if every contract holds in every episode — no partial credit:

1. **Visible task state** — opening the app renders the needed controls
2. **App-scoped action routing** — events enter the agent workflow
3. **Real-API grounding** — *naming an API is not calling it*: the named API must be invoked and the database must change
4. **Grounded visible update** — the returned entity becomes user-visible state
5. **Reopen persistence** — the entity survives teardown

The suite went through two live-world soundness audits (an 8-criterion review producing 187 repairs, and a "could a correct app fail?" sweep producing 61 expectation rewrites, 118 fixtures, and 7 quarantined cases). An online LLM behavior evaluator agreed with the deterministic assertions on 14/15 probed cases — external validity, not scoring.

### LiveUIBench-6K (synthetic companion)

`benchmarks/workflowgen/cases.livegui-bench-6k.json` (legacy filename; not checked in — regenerate with `npm run benchmark:workflowgen:6k`) scales the same episode/assertion format programmatically: **6,000 cases** (600 dev / 2,400 public / 3,000 hidden), 24,000 episodes, 72,000 assertions, plus GUI/icon/interaction quality rubrics.

### Running the benchmark

```bash
# AppWorld-grounded behavioral suite (the paper's numbers)
bash scripts/livegui/reset-appworld.sh          # pristine world before EVERY run
npm run benchmark:appworld                       # → artifacts/appworld-bench/<run>/report.json
bash scripts/livegui/run-behavior-eval.sh        # one-command behavioral runner

# Synthetic 6K suite
npm run benchmark:workflowgen -- \
  --cases benchmarks/workflowgen/cases.livegui-bench-6k.json \
  --split dev --limit 10 --model <model> \
  --out artifacts/workflowgen/my-run --continue-on-failure
npm run benchmark:workflowgen:summary            # report.json → summary + LaTeX tables
```

Ablation: set `GUIOS_APPWORLD_GROUNDING=off` to disable the real-API executor. Do **not** run the demo and the benchmark concurrently against the same `:9000` world.

Ground rules for submissions: no fallback app packages, no task-type templates in the generator, no hidden business logic in the frontend. Leaderboard claims on the sealed split require a hosted run with archived app packages, reports, and cost/latency metadata.

---

## The paper

**LiveUIBench: A Behavioral Benchmark for Agent-as-GUI Workflow Surfaces** evaluates frontier systems on the 191-case core suite (public-75 split, temperature 0.2, pristine world per run). Headline results:

| System | FWR | APR | Route | API | DB | Grounded | Persist |
|---|---|---|---|---|---|---|---|
| Direct-answer control | 0.00 | 0.00 | 0 | 0 | 0 | 0 | 0 |
| Hidden-state control | 0.00 | 0.82 | 1.00 | 1.00 | 1.00 | 0.00 | 1.00 |
| livegui-agent (gpt-5.4) | **0.05** | 0.67 | 0.92 | 0.16 | 0.18 | 0.73 | 0.72 |
| livegui-agent (opus-4.7) | **0.15** | 0.72 | 0.99 | 0.23 | 0.27 | 0.80 | 0.75 |
| No-grounding ablation | 0.00 | 0.67 | 1.00 | 0.00 | 0.00 | 0.84 | 0.76 |

FWR = Full Workflow Resolution (primary, all-or-nothing per case); APR = Assertion Pass Rate (diagnostic only).

Key findings:

1. **The APR–FWR illusion** — a scripted control that does real API work but never shows a result scores APR 0.82 with FWR 0. Assertion-level scores overstate competence by construction.
2. **Real-API grounding is the bottleneck** — surface contracts (routing 0.92–0.99, persistence ~0.75) are largely solved, but only 16–23% of required API invocations actually happen.
3. **Model discrimination** — opus-4.7 resolves ~3× more full workflows than gpt-5.4, and the gap concentrates in the API contract: the benchmark measures tool-grounding, not surface fluency.
4. **Multi-party state is unsolved** — spotify and file_system cases resolve; multi-party ledger domains (venmo / splitwise / todoist collaboration) resolve **zero** for both models, with API-call-level forensics in the appendix (divisor anchoring, wrong-service binding, duplicate-write inflation).

Every reported number is compiled from run artifacts by checked-in scripts; `npm run paper:check` verifies 68/68 claim-traceability gates. No sealed-split leaderboard claims are made. See the paper site for the manuscript: https://liveguibench.pages.dev/

## Repository layout

```text
apps/shell/            Expo universal client (Web / iOS / Android)
src/                   Vite web shell
server/                Agent gateway, multi-agent runtime, benchmark runners
packages/app-spec/     Shared spec types + component whitelist
benchmarks/
  liveuibench.json     LiveUIBench v0.2.0 — 140 released behavioral cases (dev + public)
  intentions/          Source intentions, extensions, overrides, world fixtures
  workflowgen/         LiveUIBench-6K synthetic suite schema + generator
scripts/livegui/       AppWorld reset + behavioral eval runners
site/                  Project website (guios.pages.dev)
```

## Citation

Citation information will be added once the paper is public. Until then, please link to this repository and https://liveguibench.pages.dev/.

## Contributing

Issues and PRs are welcome — especially new benchmark cases (see `benchmarks/intentions/README.md` for the case format), renderer components, and evaluation harness improvements. Benchmark case changes must pass the soundness audit criteria (satisfiability under a correct app, seedable preconditions, deterministic assertions).

## License

Apache License 2.0 — see [LICENSE](LICENSE).
