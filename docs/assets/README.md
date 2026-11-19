# EigenDynamics icon

Copied from the first-party public wiki's [favicon.svg](https://github.com/gqgs/eigendynamics-wiki/blob/a8453266dd78f58b5b90fa5ad2905e056608d6cb/assets/favicon.svg),
verified identical to the live wiki asset on 2026-11-19. Reused here at the
owner's request, not a license grant for other uses.

- `eigendynamics-icon.svg`: unchanged source, SHA-256
  `93df555c555040ec7c14bb538e2e2a972cae23a92b134fafc7706b640d46ba84`.
- `eigendynamics-icon.png`: 192 × 192 RGBA raster of that SVG. The original
  navy tile, colors and transparent rounded corners are preserved.

The PNG is used by both real and test notifications; both formats are linked
as local favicons. No external asset requests or task information are involved.

To regenerate the PNG with Inkscape (not a runtime dependency):

```sh
inkscape docs/assets/eigendynamics-icon.svg --export-type=png \
  --export-filename=docs/assets/eigendynamics-icon.png \
  --export-width=192 --export-height=192
```
