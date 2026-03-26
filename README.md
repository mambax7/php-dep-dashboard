# PHP Dep Insights

A browser-based, interactive dependency graph explorer for PHP projects.

## How it works

Drop a `data.json` file produced by [php-dep](https://github.com/DeGraciaMathieu/php-dep) and get an interactive visualization of your PHP class dependencies, with namespace drill-down navigation, filters, and cycle detection.

## Generating the data file

Install and run [php-dep](https://github.com/DeGraciaMathieu/php-dep) on your PHP project:

```bash
composer require --dev degraciamathieu/php-dep
```

```bash
vendor/bin/php-dep analyse src/ --format=json > data.json
```

Then drop the generated `data.json` into the dashboard.

## Usage

Open `index.html` in your browser (works via `file://`, no server needed).

On first load, a drop zone is shown — either:
- Drop your `data.json` onto it, or
- Click to open a file picker

Once loaded, you can:

- **Navigate namespaces** — click namespace nodes to drill down, use the breadcrumb to go back up
- **Switch view modes** — toggle between folder view (one node per namespace) and class view (all individual classes, grouped by namespace)
- **Focus a node** — click any class to highlight its direct dependencies and dependants; adjust depth (1 or 2 hops) in the detail panel
- **Filter** — left sidebar lets you filter by class type (class/interface/trait/enum), edge confidence, namespace, and whether to show external classes
- **Search** — top bar search finds any class by FQCN and navigates to it in the graph
- **Cycles** — circular dependencies are highlighted in red; warnings are listed in the top-right badge
- **Export** — export the current graph view as a PNG

