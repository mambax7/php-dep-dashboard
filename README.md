# PHP Dep Insights

A browser-based, interactive dependency graph explorer for PHP projects.

## Installation

```bash
git clone https://github.com/DeGraciaMathieu/php-dep-dashboard
cd php-dep-dashboard
composer install
```

## Usage

Run the `analyse` command with the path to your PHP project:

```bash
bin/analyse ../my-project/src/
```

This will:
1. Run [php-dep](https://github.com/DeGraciaMathieu/php-dep) on the given path
2. Generate a `<folder-name>.json` file in the dashboard directory

Add `--open` to automatically open the dashboard in your browser after analysis:

```bash
bin/analyse ../my-project/src/ --open
```

## What you get

Once the dashboard is open:

- **Navigate namespaces** — click namespace nodes to drill down, use the breadcrumb to go back up
- **Switch view modes** — toggle between folder view (one node per namespace) and class view (all individual classes, grouped by namespace)
- **Focus a node** — click any class to highlight its direct dependencies and dependants; adjust depth (1 or 2 hops) in the detail panel
- **Filter** — left sidebar lets you filter by class type (class/interface/trait/enum), edge confidence, namespace, and whether to show external classes
- **Search** — top bar search finds any class by FQCN and navigates to it in the graph
- **Cycles** — circular dependencies are highlighted in red; warnings are listed in the top-right badge
- **Export** — export the current graph view as a PNG

## Manual usage

You can also generate `data.json` manually and drop it into the dashboard:

```bash
vendor/bin/php-dep analyse src/ --format=json > data.json
```

Then open `index.html` in your browser (works via `file://`, no server needed).
