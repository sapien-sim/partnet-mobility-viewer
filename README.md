# PartNet-Mobility Viewer

A single-page web viewer for the PartNet-Mobility dataset: browse the models
by category, inspect an articulated model in 3D, move its joints, and toggle
parts in its part tree. It runs locally against the dataset on HuggingFace,
pulling each model on demand.

## Run

Requirements: Node.js, Python 3.

```sh
npm install
npm run build
python3 -u server.py 4200
```

Then open the served page in a browser (the server listens on the given
port). The release runs with no built-in HuggingFace token.

## HuggingFace token

Browsing the dataset needs your own HuggingFace read token:

1. Request access to the gated dataset
   [sapien-sim/PartNetMobility](https://huggingface.co/datasets/sapien-sim/PartNetMobility).
2. Create a read token under Settings -> Access Tokens.
3. Paste the token into the input box in the page header.

The token is kept in the browser's localStorage and sent with API requests;
the server uses it in memory only, only to fetch from huggingface.co, and
never persists or logs it.

For development, `python3 -u server.py 4200 --dev-hf-token-env` falls back to
an `HF_TOKEN` environment variable when the request carries no token.

## Preview thumbnails

`tools/gen-previews.mjs` renders a preview image for every model into
`previews/` (the repository already includes them). To regenerate, run the
server first, then:

```sh
cd tools
npm install
node gen-previews.mjs [--ids 1,2,3] [--concurrency 4]
```

## Credits

The models come from the PartNet-Mobility dataset of the SAPIEN project.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
