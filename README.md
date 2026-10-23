# LiveUIAgent

**Create apps that adapt to you.**

Describe an app, use it, and revise it while keeping your data. Choose a model and harness, manage Memory, and evaluate complete workflows with LiveUIBench.

[LiveUIAgent](http://liveui.example.org/liveui/) · [Paper](https://arxiv.org/abs/2610.27977v1) · [Benchmark](benchmarks/README.md) · [Deployment](deploy/README.md)

![LiveUIAgent applications and workflows](paper/agent-as-app-teaser.png)

## Quickstart

Requires **Node.js 22.19+**.

```sh
git clone https://github.com/tongmd/liveuibench.git
cd liveuibench
npm ci --workspace @guios/dsh-plugin --include-workspace-root
cp .env.example .env
npm run build
npm start
```

Open **http://127.0.0.1:8787**, configure your API base, key, and model in **Settings**, then describe an app. You can also configure the provider using [.env.example](.env.example).

| Harness | Applications | Setup |
| --- | --- | --- |
| LiveUIAgent (`native`) | App specifications rendered by the shared runtime | Included |
| DeepSeek Harness (`dsh`) | HTML apps with storage and AI bridges | Configure `GUIOS_DSH_API_BASE` and gateway authentication |

New apps use the selected model and harness. Existing apps keep their harness. The [DSH plugin](packages/dsh-plugin/README.md) can also run inside a DSH web profile.

## Evaluate with LiveUIBench

The dataset includes **319 cases: 147 dev and 172 public test**, with 230 initial-world fixtures. Workflows cover **open → submit → revise → reopen**.

Run an offline smoke check:

```sh
npm run bench:liveui -- --mock
```

For live evaluation, install AppWorld and export `OPENAI_API_BASE`, `OPENAI_API_KEY`, and your model configuration:

```sh
npm run bench:parallel -- \
  --workers 2 \
  --appworld-bin /absolute/path/to/appworld \
  --appworld-root /absolute/path/to/appworld-data \
  --harness native --model YOUR_MODEL \
  --split dev --limit 2 --evaluator both \
  --out artifacts/liveuibench/native-dev
```

Each case runs in a separate runtime, database, and AppWorld instance. Managed parallel evaluation supports the LiveUIAgent harness. See the [benchmark guide](benchmarks/README.md) for full runs, evaluators, metrics, and DSH diagnostics.

## Deploy

```sh
npm run deploy -- \
  --host DEPLOY_HOST \
  --remote-env /etc/liveuiagent.env \
  --nginx-site /etc/nginx/sites-available/liveui \
  --auth-file /etc/nginx/liveui.htpasswd
```

Deploys to **`/liveui/`** with authentication, persistent storage, and health-checked rollback. See [setup and options](deploy/README.md).

## Development

```sh
npm run dev
npm test
npm run check:docs
npm run check:release

# Browser checks require CHROME_PATH.
npm run test:runtime-ui
npm run test:evaluator
npm run test:catalog
```

The served frontend is in `frontend/snapshot/`. After editing it, run `node scripts/update-frontend-manifest.mjs`. `legacy-web/` is an earlier implementation with a separate build. HTTP examples: [LiveUIAgent](examples/create-native.json), [DSH](examples/create-dsh.json).

## Citation

**LiveUIBench: Evaluating Agent as App Workflows** — Tong Zhang, Yuxuan Cheng, Ruimin Zhang, Yun Peng, and Tao Xie, 2026.

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

[PDF](paper/liveuibench-arxiv-v1.pdf) · [BibTeX](citation.bib) · [CITATION.cff](CITATION.cff)

Code: [Apache-2.0](LICENSE). Paper and figure: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
