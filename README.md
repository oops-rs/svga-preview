# SVGA Preview

Standalone previewer for `svga.elata.ai`, built on the published Rust
[`svga` crate](https://crates.io/crates/svga). Local files stay on the device. URL files are fetched by the
browser with credentials omitted; their source must allow CORS. There is no
upload endpoint, database, analytics, account system, or proxy.

Live: **https://svga.elata.ai/**. Deployed to Cloudflare Worker `svga-preview`
on 2026-10-27; version `922d6990-370e-4865-b4f6-d6efff53862d`.

## Run and build

Requirements: stable Rust, the `wasm32-unknown-unknown` target, and Node.js 24.
The pinned npm `wasm-pack` package supplies the build tool and obtains the
matching `wasm-bindgen` CLI on first build.

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run wasm
npm run dev
```

```sh
npm run build                 # Rust/WASM + Vite → dist/
npx playwright install chromium webkit
npm test                     # browser tests against the built site
cargo test --manifest-path wasm/Cargo.toml --locked
cargo clippy --manifest-path wasm/Cargo.toml --locked --all-targets -- -D warnings
```

Run these commands from this repository's root. The Rust adapter in `wasm/`
depends on `svga = "=0.1.4"` from crates.io; no sibling checkout or private
repository access is required. It is unpublished and leaves the codec's API
unchanged. Generated WASM and `dist/` are rebuilt, not committed. Both lockfiles
are committed. The npm package is marked private to prevent accidental npm
publication; this does not restrict publishing the Git repository publicly.

## Publish this repository on GitHub

Create an empty public GitHub repository, then run from this repository:

```sh
git remote add origin <your-github-repository-url>
git push -u origin main
```

No remote is preconfigured. `.github/workflows/ci.yml` builds and tests a fresh
checkout without deployment credentials. Once the GitHub URL exists, the site
navigation can link to it; the current link explicitly points to the codec.

## Features and boundaries

- Open or drop a local file; load an HTTPS URL (HTTP is allowed on localhost).
- Play/pause, single-frame stepping, scrubbing, loop control, 0.25–2× speed.
- Fit/50/100/200% zoom; transparent, white, or dark canvas backgrounds.
- Dimensions, duration, FPS, frames, layer/image counts, file size and decode time.
- SVGA 2.x zlib/protobuf, zipped `movie.binary`, and 1.x `movie.spec` archives.
- Embedded PNG/JPEG, affine transforms, opacity, SVG paths, rounded rectangles,
  ellipses, stroke styles, shape reuse, clipping and grouped alpha mattes.
- Keyboard: Space toggles playback; arrow keys step when focus is outside a control.
  Reduced-motion preferences disable autoplay. Hidden pages pause playback.

Audio tracks are reported but not played. Animated PNG assets use a still
frame. Missing assets or matte references show warnings; a dangling matte's
content is shown unmasked. Runtime text/image substitution is not supported.
This is a visual previewer, not a guarantee of pixel parity with every native
SVGA player or exporter. Embedded images use their intrinsic pixel size and
the frame's affine matrix, matching the upstream web player's coordinate model.

Bounds: 32 MiB input, 96 MiB inflated/expanded assets, 4 MiB legacy JSON,
250,000 decoded elements, 4096 layers/assets, canvas axes up to 4096 px,
1–240 FPS, 36,000 frames, 64 million decoded image pixels, image axes up to
8192 px, 100,000 bytes per vector path and 2 MiB of paths in total. WASM decoding
runs in a disposable worker with a 20-second timeout. A load can be cancelled
or replaced; the previous valid preview survives a failed load.

## Hosting recommendation: Cloudflare

Keep the source and CI on GitHub; serve `dist/` with **Cloudflare Workers Static
Assets**. This is static hosting: no Worker application code or backend is
needed. Cloudflare already owns the DNS zone, and a Worker custom domain
provisions the hostname's DNS records and certificate.

| | Cloudflare Static Assets | GitHub Pages |
| --- | --- | --- |
| Browser WASM | Supported | Supported |
| Custom domain | Managed in the existing Cloudflare zone | GitHub configuration plus DNS CNAME |
| Static traffic | Free and unlimited static requests | 100 GB/month soft bandwidth limit |
| Headers | `_headers` supplies CSP, caching and privacy headers | No equivalent per-project custom response-header file |
| Best fit here | Recommended | Fine alternative for a simple open-source demo |

References checked 2026-10-27: [Cloudflare static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/),
[Cloudflare custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits),
[GitHub custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

## Deploy

`wrangler.jsonc` names the Worker `svga-preview` and binds `svga.elata.ai`.
Use the Cloudflare account that owns `elata.ai`; do not overwrite a pre-existing
DNS record or Worker belonging to another app. No credentials belong in this repo.

```sh
npx wrangler login            # only if the account is not already authenticated
npm run deploy
```

For an account with multiple zones/accounts, set `CLOUDFLARE_ACCOUNT_ID` in the
deployment environment. For automation, use a scoped `CLOUDFLARE_API_TOKEN`
with the required Workers and zone permissions. Do not grant unrelated services.
The included GitHub workflow validates and archives the site; it does not
automatically deploy. A future release workflow can deploy that validated
artifact with GitHub environment secrets, or Cloudflare Builds can connect
to the GitHub repo with the Rust/WASM build commands above.

```sh
npx wrangler deploy --dry-run # validate packaging without publishing
npx wrangler dev --local --port 8787
PREVIEW_URL=http://127.0.0.1:8787 npm test # verify Cloudflare's headers locally
```

## Evidence and ablation

Browser tests independently encode tiny protobuf/ZIP/PNG fixtures, load them
through the real WASM worker, and inspect actual Canvas pixels. They cover
transparency, group alpha mattes, clips, shape reuse, image decoding, legacy
containers, invalid files, limits, URL failures, cancellation, playback and mobile
layout. The ablation test removes one input feature at a time: removing a matte
turns an outside pixel from red to blue; removing a clip makes a transparent
pixel opaque; removing `Keep` makes the next frame disappear. This demonstrates
why each mechanism is necessary rather than merely checking its code structure.
An oversized-canvas layout comparison also found that centered overflow placed
the left edge at −93 px instead of the viewport's 71 px. Start alignment with
automatic margins retains centering when the image fits and keeps enlarged
images fully scrollable; both browser projects assert reachable top/left edges.

Architecture ablation: no backend is needed for local files or CORS-enabled
URLs; no UI framework or external player is needed for playback; the worker is
retained to make synchronous Rust decoding cancellable. Separate WASM glue
preserves the codec-only package contract.

Standalone extraction verified on 2026-10-27: the selected Git source was
exported into an empty temporary directory with no sibling codec checkout,
`node_modules`, WASM package, or build output. `npm ci`, the production build,
Rust formatting, Clippy with warnings denied, both Rust tests, and all 20
self-contained Chromium/WebKit checks passed there. Cargo metadata confirmed
that every dependency outside the adapter resolves from crates.io. Removing
the original checkout therefore leaves the application build and behavior intact.

Verified on 2026-10-27: 28 browser checks passed across Chromium and WebKit
against Wrangler's local static-assets runtime, including every frame of
Goddess, Rocket, Rose and heartbeat from the local corpus. The Rocket file's
three dangling matte references are reported as warnings. Two Rust adapter
tests, adapter Clippy with warnings denied, formatting, and a Wrangler
deployment dry run passed. The WASM response uses `application/wasm`; CSP,
privacy headers and immutable caching of hashed assets were checked.
The same 28 checks were exercised against the public HTTPS deployment: 25
passed initially, and three cold-start checks passed after allowing 20 seconds
for WASM startup rather than the localhost-oriented five-second assertion
timeout. No application changes were needed for those retries.

Optional local corpus verification (assets are never copied into the website):

```sh
SVGA_BROWSER_SAMPLES=/path/to/svga/files npm test
```

The demo is original vector artwork, generated with this repository's MIT-licensed
code. Regenerate it from the repository root:

```sh
cargo run --manifest-path wasm/Cargo.toml --example generate_demo -- public/demo.svga
```

## License

MIT — see [LICENSE](LICENSE).
