# MWAS Graph Viewer

Graph viewer for clusters of related findings from the totiviridiae metadata-wide association study. Each node is a statistical finding, edges join findings an LLM judged related, and clusters come from Leiden clustering of that graph. Nodes can be coloured by cluster, p-value or effect size (Cohen's d).

Adapted from [DittoGraphVisualization](https://github.com/InvestigativeJournalismFoundation/DittoGraphVisualization).

## Data

Load `clusters.csv` and `edges.csv` into a new, named subfolder of `viewer/public/data/`. Then add this new name to `index.json`. It will appear as an option in the dropdown.

`clusters.csv` has columns `{name, cluster_id}`, plus optional `pvalue` and `cohens_d` columns that enable the p-value and effect size colourings. `edges.csv` has columns `{name1, name2, score}`.

The viewer splits CSV lines on commas without handling quotes, so names must not contain commas.

## Development

```bash
cd viewer
npm i
npm run dev
```
