# Third-party notices

lil-slim is a derivative work. The upstream copyright and permission notices below are
retained as the MIT License requires. The named projects and their authors are not affiliated with
or endorsing this project.

## oh-my-opencode-slim

Source of the orchestrator and specialist prompts, skills, and overall design.
https://github.com/alvinunreal/oh-my-opencode-slim

```text
MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

## slim-claude

The `arbiter`, `chronicler`, `council`, `councillor`, `debugger`, `documenter`, `hunter`,
`janitor`, `paladin`, `proctor` and `validator` agents and the `council` skill were taken from
https://github.com/aw4e/slim-claude (MIT, Copyright (c) 2026 aw4e), with prompts adapted only for
namespacing and removal of an optional third-party shell hint. That project adapted them from the
sources below.

```text
MIT License

Copyright (c) 2026 aw4e

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## oh-my-opencode-marketplace

Community agents adapted from https://github.com/alvinunreal/oh-my-opencode-marketplace (MIT):

- arbiter: capyBearista (https://github.com/capyBearista), MIT, from capybearista/arbiter
- fast-generic: Alvin, MIT, from alvin/fast-generic
- chronicler: capyBearista (https://github.com/capyBearista), MIT, from capybearista/chronicler
- debugger: Alvin, MIT, from alvin/debugger
- documenter: Alvin, MIT, from alvin/documenter
- hunter: capyBearista (https://github.com/capyBearista), MIT, from capybearista/hunter
- janitor: hbollon (https://github.com/hbollon), MIT, from alvin/janitor
- paladin: stevio2d (https://github.com/stevio2d), MIT, from alvin/paladin
- proctor: capyBearista (https://github.com/capyBearista), MIT, from capybearista/proctor
- skeptic: mhenke (https://github.com/mhenke), MIT, from mhenke/skeptic
- validator: Alvin, MIT, from alvin/validator

Each is MIT licensed; see the upstream repositories for the full license text. The marketplace
repository ships no top-level LICENSE file; each agent manifest declares `license: MIT` and names
its author, which is what this notice relies on.

Verified against the marketplace artifact manifests (dist/v3/artifacts/*) on 2026-11-20: authors and the `MIT` license match the list above for all nine agents.

## coleam00/Archon

`hunter` and `proctor` are adapted (through the marketplace agents above) from Archon's
`silent-failure-hunter` and `pr-test-analyzer` agent templates.
https://github.com/coleam00/Archon

```text
MIT License

Copyright (c) 2025-2026 Cole Medin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
