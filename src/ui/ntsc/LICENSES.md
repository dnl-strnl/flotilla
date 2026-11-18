# Vendored: ntsc-rs

`ntsc_rs_web_wrapper_bg.wasm` and `ntsc_rs_web_wrapper.js` are build artifacts of
[ntsc-rs](https://github.com/ntsc-rs/ntsc-rs) by valadaptive, taken from the deployed
web app at <https://web.ntsc.rs>.

Pulled 2026-10-22 from:

- `https://web.ntsc.rs/assets/ntsc_rs_web_wrapper_bg-DfF4bjsS.wasm`
- `https://web.ntsc.rs/assets/effect-worker.worker-DNyaS0uN.js.map` → `sourcesContent` entry
  `ntsc-rs-web-wrapper/build/ntsc_rs_web_wrapper.js`

The `.js` is the unmodified wasm-bindgen glue recovered verbatim from the deployed
sourcemap — not hand-written — so it is a guaranteed match for the `.wasm` beside it.
`ntsc_rs_web_wrapper.d.ts` IS hand-written (wasm-bindgen's `.d.ts` isn't published)
and must be updated by hand if these are ever re-vendored.

To rebuild from source instead, see `ntsc-rs-web-wrapper/README.md` upstream;
the Docker path is `docker build --output type=local,dest=. --target=export .`.

ntsc-rs is licensed under any of Apache-2.0, MIT, or ISC at your option.
See the LICENSE-APACHE-2.0 / LICENSE-MIT / LICENSE-ISC files in the upstream repo.
