# Third-party notices and source provenance

This package depends on packages listed in its `package.json`; their licenses remain with their respective publishers.

The status graph includes code ported from OpenChamber PR #3008. Host API access uses the public SDK. The graph source and service ports retain this notice in release archives.

The original compact graph source is OpenChamber commit `5186bb6b17e6c5ebc1ade97bfd000d858d8e4d92` (PR #3008), MIT-licensed. `src/panel/original/README.md` records the copied modules and adapter changes. Earlier service and domain work used commit `9f554fa0e87395e1978804380becf7284e04968a` and its upstream merge base `83ec4fbde25a9d141785716bebe0371925f895b5`.

The SDK input is the published, MIT-licensed `@openchamber/sdk@2.0.1`. Its exact package resolution is recorded in `bun.lock`. The extension uses the official Work Status and commit-opening APIs; it does not require a modified host or a preview SDK.

## SCM history graph

The original graph model and SVG renderer were adapted from Visual Studio Code's SCM history implementation. Their Microsoft copyright notices are preserved in the source.

Copyright (c) Microsoft Corporation. All rights reserved.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
