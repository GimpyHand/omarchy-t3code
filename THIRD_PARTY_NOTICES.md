# Third-party notices

This project is MIT-licensed (see `LICENSE`, copyright John Pals). Bralyx Digital
publishes T3 Command Center from https://github.com/GimpyHand/omarchy-t3code.
Packaged plugin archives also ship that notice as `LICENSE` and
`licenses/OMARCHY-T3CODE-LICENSE`.

## T3 Code

The bridge reuses selected source modules from T3 Code through the pinned
`upstream/t3code` Git submodule. The vector path in `qml/T3Mark.qml` is also
derived from that revision.

T3 Code is Copyright (c) 2026 T3 Tools Inc. and licensed under the MIT License.
The full notice is available at `upstream/t3code/LICENSE` and is included in
packaged artifacts as `licenses/T3-CODE-LICENSE`.

## Bundled Node.js runtime and JavaScript dependencies

Standalone / marketplace artifacts embed Node.js and bundled JavaScript
dependencies. Packaging discovers those dependencies from the generated source
map and ships their exact notices under `licenses/`, with versions and
filenames listed in `licenses/BUNDLED-LICENSES.json`. Node's complete runtime
notice (including its bundled third-party notices) is shipped as
`licenses/NODEJS-LICENSE`.
