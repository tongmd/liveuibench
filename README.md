# LiveUIBench

**Evaluate an agent through the applications people keep using.**

LiveUIBench evaluates **open → submit → revise → reopen** workflows, including the interface, service actions, and saved state. This repository also includes **LiveUIAgent**, the application runtime used to generate, run, personalize, and evaluate apps with selectable models and harnesses.

[Paper](https://arxiv.org/abs/2610.27977v1) · [LiveUIAgent](http://liveui.example.org/liveui/) · [Quickstart](docs/QUICKSTART.md) · [Benchmark guide](docs/benchmarks/README.md) · [Deployment](deploy/README.md) · [Documentation](docs/README.md)

The hosted application requires authentication. This repository remains private; access to the application and access to the repository are managed separately.

![Agent as App: personal applications and changing requirements share a runtime while retaining interface behavior and saved information.](paper/agent-as-app-teaser.png)

*Figure 1 from Zhang et al., [arXiv:2610.27977v1](https://arxiv.org/abs/2610.27977v1), reproduced unchanged under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).*

## Run LiveUIAgent

Use **Node.js 22.19 or newer**. Install the runtime and DSH plugin without the optional mobile dependencies:

```sh
git clone https://github.com/tongmd/liveuibench.git
cd liveuibench
npm ci --workspace @guios/dsh-plugin --include-workspace-root
cp .env.example .env
npm run build
npm start
```

Open **http://127.0.0.1:8787**. In Settings, enter an OpenAI-compatible API base, API key, and model; then describe an application. The server can start without model credentials, but generation requires a configured provider. You can also set these values in `.env`. See [configuration](docs/CONFIGURATION.md) for provider settings and storage paths.

The toolbar selects a model and harness for new apps:

| Harness | Generated application | Setup |
| --- | --- | --- |
| `native` | Validated app specification rendered by the shared runtime | Available with the local server |
| `dsh` | Complete HTML application with storage and AI bridges | Requires a configured DSH service and authenticated identity |

Existing apps retain their original harness. DSH model/provider overrides depend on the connected service's advertised capabilities; unavailable selections return errors. The separate [native DSH plugin](packages/dsh-plugin/README.md) embeds LiveUIAgent in a DSH web profile.

For development, `npm run dev` serves the current frontend and watches the backend. [Example requests](examples/README.md) show the HTTP entry points.

## Run the benchmark

The bundled snapshot contains **319 cases: 147 `dev` and 172 `public_test`**, with 230 fixture files. Sealed cases are excluded. The [provenance manifest](benchmarks/provenance.json) records the dataset and fixture hashes; these identify the snapshot and do not certify every annotation as human verified.

Start with the offline runner smoke test:

```sh
npm run bench:liveui -- --mock
```

This uses a dedicated fixture dataset and mock runtime. Reports are labeled `mode: "mock"`, `comparable: false`; they are runner checks, not model results.

For a real evaluation, install AppWorld separately and export provider credentials into the runner's environment (`OPENAI_API_BASE`, `OPENAI_API_KEY`, and any shared model routes). The parallel runner creates a fresh runtime, database, and AppWorld instance for each case; it does not reuse desktop settings or load the local `.env`:

```sh
npm run bench:parallel -- \
  --workers 2 \
  --appworld-bin /absolute/path/to/appworld \
  --appworld-root /absolute/path/to/appworld-data \
  --harness native --model YOUR_MODEL \
  --split dev --limit 2 --evaluator both \
  --out artifacts/liveuibench/native-dev
```

Use `--split all --limit 319` to select the complete bundled snapshot after a small run succeeds. Managed parallel execution currently supports native only. Each selected case consumes model calls; `--evaluator both` also runs the independent behavior evaluator. No live evaluation starts during installation or CI. The [benchmark guide](docs/benchmarks/README.md) covers serial execution, fixture preparation, evaluator modes, evidence, and strict failure accounting.

### Read the evidence correctly

| Check | What it measures |
| --- | --- |
| Scripted native workflow | Deterministic assertions over programmatic app actions, responses, traces, and state |
| Independent behavior evaluator | Separate bounded interactions and a model-based judgment; runs after scripted reopen scoring |
| Native GUI evaluator | Structural/default-render checks; a proxy, not a perceptual quality score |
| DSH GUI and behavior evaluation | Actual Chrome DOM, interactions, screenshots, and persisted HTML-app state |

Workflow pass rates use the deterministic scripted assertions; GUI and independent evaluator results are reported separately. Assertion values and case audit metadata are excluded from generation. Fixture contacts are also excluded by default; `--fixture-contacts` enables an assisted diagnostic setting that must be reported separately.

DSH cannot currently provide all of the native AppWorld trace and database evidence. Unsupported assertions remain failed, and DSH benchmark runs are diagnostic rather than directly comparable to native scores. Reports preserve failures, selected-case denominators, configuration, and artifacts. This software release does not by itself reproduce the paper's results.

## Deploy

The deployment script installs a versioned release behind an authenticated Nginx `/liveui/` route, with persistent state and health-checked rollback:

```sh
npm run deploy -- \
  --host DEPLOY_HOST \
  --remote-env /etc/liveuiagent.env \
  --nginx-site /etc/nginx/sites-available/liveui \
  --auth-file /etc/nginx/liveui.htpasswd
```

Replace `DEPLOY_HOST` with your SSH host or alias. The remote environment and password file stay outside Git. See [deployment prerequisites and options](deploy/README.md), including first-time setup. The application expects a trusted gateway to establish user identity; `X-Guios-User` is not an authentication mechanism for an exposed backend.

## Develop and test

```sh
npm test                    # Build and offline runtime/plugin/benchmark tests
npm run test:parallel       # Isolated worker orchestration tests
npm run test:deploy         # Deployment script checks
npm run check:release       # Source, credentials, and asset provenance checks

# Requires an installed Chrome/Chromium executable in CHROME_PATH.
npm run test:runtime-ui
npm run test:evaluator
npm run test:catalog
```

CI runs offline checks and real-browser tests against local fixtures, and retains screenshots. It does not supply model credentials or contact a live AppWorld service. See [contribution guidance](CONTRIBUTING.md) and [security boundaries](SECURITY.md).

The current frontend lives in `frontend/snapshot/` with editable sidecar resources and a verified hash manifest. `legacy-web/` is an earlier React implementation; its build is separate. The optional Expo shell in `apps/shell/` requires all workspace dependencies and separate mobile validation.

## Cite

Tong Zhang, Yuxuan Cheng, Ruimin Zhang, Yun Peng, and Tao Xie. **LiveUIBench: Evaluating Agent as App Workflows.** arXiv:2610.27977v1, 2026.

```bibtex
@misc{zhang2026liveuibench,
  title = {{LiveUIBench}: Evaluating Agent as App Workflows},
  author = {Zhang, Tong and Cheng, Yuxuan and Zhang, Ruimin and Peng, Yun and Xie, Tao},
  year = {2026},
  eprint = {2610.27977},
  archivePrefix = {arXiv},
  primaryClass = {cs.SE},
  url = {https://arxiv.org/abs/2610.27977v1}
}
```

[CITATION.cff](CITATION.cff), [complete BibTeX](citation.bib), and the [paper assets and provenance](paper/README.md) are included. Code is licensed under [Apache-2.0](LICENSE); the paper and its figure have their own license documented above.
