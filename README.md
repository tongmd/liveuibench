# LiveUIBench

[Project page](https://liveuibench.stonezhang.com/) | [Paper (arXiv)](https://arxiv.org/abs/2610.27977)

[Paper](https://arxiv.org/abs/2610.27977) | [Dataset and evaluation](benchmarks/README.md) | [LiveUIAgent](https://github.com/tongmd/liveuiagent) | [BibTeX](citation.bib)

LiveUIBench evaluates Agent as App workflows: an application must respond to changing goals, execute service actions, preserve saved information, and remain useful on return visits. This repository contains the evaluation data, fixtures, runners, and metrics. The application runtime is maintained separately in LiveUIAgent and pinned here as the `liveuiagent/` Git submodule.

## Get Started

Requires Node.js 22.19 or later. Clone the runtime together with the benchmark:

```bash
git clone --recurse-submodules https://github.com/tongmd/liveuibench.git
cd liveuibench
npm run setup
npm run build
npm run bench:liveui -- --mock
```

For an existing checkout, run `git submodule update --init --recursive` first. The offline smoke check uses fixture responses and makes no model calls; its report is explicitly marked as a mock run.

## Dataset

The release includes 319 cases across the development and public test splits, with 230 initial-world fixtures. Ordered interactions cover opening an application, submitting information, revising a request, and reopening saved state.

- [Cases](benchmarks/liveuibench.json)
- [Fixtures](benchmarks/fixtures/)
- [Dataset provenance](benchmarks/provenance.json)
- [Evaluation guide](benchmarks/README.md)

The published benchmark data and fixture hashes are preserved.

## Run Evaluation

Install AppWorld and its data. Export `OPENAI_API_BASE`, `OPENAI_API_KEY`, and your model configuration, then run an isolated evaluation:

```bash
npm run bench:parallel -- \
  --workers 2 \
  --appworld-bin /absolute/path/to/appworld \
  --appworld-root /absolute/path/to/appworld-data \
  --harness native --model YOUR_MODEL \
  --split dev --limit 2 --evaluator both \
  --out artifacts/liveuibench/native-dev
```

Each case owns its runtime process, SQLite database, application registry, AppWorld instance, and evidence directory. Use a fresh output directory for each run. See the [evaluation guide](benchmarks/README.md) for metrics, complete runs, serial evaluation, and diagnostic harnesses.

## Development

```bash
npm test
npm run check:docs
npm run check:release
```

To update the runtime, review the new LiveUIAgent commit, update the submodule pointer, and rerun the tests before committing that pointer. Application UI and runtime changes belong in [LiveUIAgent](https://github.com/tongmd/liveuiagent).

## Citation

```bibtex
@misc{zhang2026liveuibench,
  title = {{LiveUIBench}: Evaluating Agent as App Workflows},
  author = {Zhang, Tong and Cheng, Yuxuan and Zhang, Ruimin and Peng, Yun and Xie, Tao},
  year = {2026},
  eprint = {2610.27977},
  archivePrefix = {arXiv},
  primaryClass = {cs.SE},
  url = {https://arxiv.org/abs/2610.27977}
}
```

[BibTeX](citation.bib) · [CITATION.cff](CITATION.cff) · [Paper PDF](https://arxiv.org/pdf/2610.27977).

Code: [Apache-2.0](LICENSE). Paper and figure: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
