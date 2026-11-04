# Third-party notices

Eyrie is licensed under [AGPL-3.0-only](LICENSE). This repository vendors no third-party code: dependencies are installed from npm by `pnpm install`, each with its own licence file under `node_modules/`.

The built web UI (`apps/web/dist`, produced by `pnpm build`) bundles some of those dependencies, the engine loads others at run time, and the desktop app (`apps/desktop`) bundles both, plus Electron and the few packages listed under its own heading. Their copyright notices and licences are reproduced below, and **this file must accompany any distribution of a built UI or packaged build of Eyrie**.

Type-only packages (`@types/*`, `graphology-types`, `csstype`) and install-time helpers (`node-addon-api`, `node-gyp-build`) are not part of what runs and are not listed.

## elkjs licence election

`elkjs` is offered under **EPL-2.0 OR GPL-3.0-or-later**. Eyrie uses `elkjs` under the **GPL-3.0-or-later** option, which is compatible with AGPL-3.0-only (GPL-3.0 §13 and AGPL-3.0 §13 permit combining the two). Eyrie does not rely on the EPL-2.0 option.

## Bundled into the web UI

| Package | Version | Licence | Copyright | Source |
| --- | --- | --- | --- | --- |
| `react`, `react-dom`, `scheduler`, `use-sync-external-store` | 19.3.0, 19.3.0, 0.28.0, 1.7.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. | https://github.com/facebook/react |
| `@xyflow/react`, `@xyflow/system` | 12.12.0, 0.0.83 | MIT | Copyright (c) 2019-2025 webkid GmbH | https://github.com/xyflow/xyflow |
| `zustand` | 4.5.7 | MIT | Copyright (c) 2019 Paul Henschel | https://github.com/pmndrs/zustand |
| `classcat` | 5.0.5 | MIT | Copyright © Jorge Bucaran | https://github.com/jorgebucaran/classcat |
| `d3-color`, `d3-dispatch`, `d3-drag`, `d3-interpolate`, `d3-selection`, `d3-timer`, `d3-transition`, `d3-zoom` | 3.x | ISC | Copyright 2010-2022 Mike Bostock (d3-color); Copyright 2010-2021 Mike Bostock (others) | https://github.com/d3 |
| `d3-ease` | 3.0.1 | BSD-3-Clause | Copyright 2010-2021 Mike Bostock; Copyright 2001 Robert Penner | https://github.com/d3/d3-ease |
| `three` | 0.186.1 | MIT | Copyright © 2010-2026 three.js authors | https://github.com/mrdoob/three.js |
| `animejs` | 4.5.0 | MIT | Copyright (c) 2025 Julian Garnier | https://github.com/juliangarnier/anime |
| `elkjs` | 0.12.0 | EPL-2.0 OR GPL-3.0-or-later (used under GPL-3.0-or-later) | Copyright (c) Kiel University and others | https://github.com/kieler/elkjs |
| `lucide-react` | 1.52.0 | ISC; icons derived from Feather are MIT | Copyright (c) 2026 Lucide Icons and Contributors; Feather icons Copyright (c) 2013-present Cole Bemis | https://github.com/lucide-icons/lucide |
| `@fontsource-variable/archivo` (Archivo font) | 5.3.0 | OFL-1.1 | Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo) | https://github.com/fontsource/font-files |
| `@fontsource/fragment-mono` (Fragment Mono font) | 5.3.0 | OFL-1.1 | Copyright 2022 The Fragment-Mono Project Authors (https://github.com/weiweihuanghuang/fragment-mono) | https://github.com/fontsource/font-files |

## Used by the engine and server at run time

| Package | Version | Licence | Copyright | Source |
| --- | --- | --- | --- | --- |
| `web-tree-sitter` | 0.27.0 | MIT | Copyright (c) 2018 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter |
| `tree-sitter-javascript` | 0.25.0 | MIT | Copyright (c) 2014 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-javascript |
| `tree-sitter-typescript` | 0.23.2 | MIT | Copyright (c) 2017 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-typescript |
| `tree-sitter-python` | 0.25.0 | MIT | Copyright (c) 2016 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-python |
| `tree-sitter-go` | 0.25.0 | MIT | Copyright (c) 2014 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-go |
| `tree-sitter-java` | 0.23.5 | MIT | Copyright (c) 2017 Ayman Nadeem | https://github.com/tree-sitter/tree-sitter-java |
| `tree-sitter-c-sharp` | 0.23.5 | MIT | Copyright (c) 2014-2023 Max Brunsfeld, Damien Guard, Amaan Qureshi, and contributors | https://github.com/tree-sitter/tree-sitter-c-sharp |
| `tree-sitter-php` | 0.24.2 | MIT | Copyright (c) 2017 Josh Vera, GitHub | https://github.com/tree-sitter/tree-sitter-php |
| `tree-sitter-ruby` | 0.23.1 | MIT | Copyright (c) 2016 Rob Rix | https://github.com/tree-sitter/tree-sitter-ruby |
| `tree-sitter-rust` | 0.24.0 | MIT | Copyright (c) 2017 Maxim Sokolov | https://github.com/tree-sitter/tree-sitter-rust |
| `@tree-sitter-grammars/tree-sitter-kotlin` | 1.1.0 | MIT | Copyright (c) 2024 Amaan Qureshi | https://github.com/tree-sitter-grammars/tree-sitter-kotlin |
| `@binclusive/tree-sitter-swift-wasm` | 0.1.0 | MIT | Copyright (c) 2021 alex-pinkus | https://github.com/Binclusive/monorepo |
| `tree-sitter-c` | 0.24.1 | MIT | Copyright (c) 2014 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-c |
| `tree-sitter-cpp` | 0.23.4 | MIT | Copyright (c) 2014 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-cpp |
| `@plurnk/plurnk-mimetypes-grammar-dart` | 2.0.0 | MIT | Copyright (c) 2026 PossumTech Laboratories, LLC | https://github.com/plurnk/plurnk-mimetypes-grammar-dart |
| `tree-sitter-objc` | 3.0.2 | MIT | Copyright (c) 2023 Amaan Qureshi | https://github.com/tree-sitter-grammars/tree-sitter-objc |
| `@tree-sitter-grammars/tree-sitter-lua` | 0.4.1 | MIT | Copyright (c) 2021 Munif Tanjim | https://github.com/tree-sitter-grammars/tree-sitter-lua |
| `graphology` | 0.26.0 | MIT | Copyright (c) 2016-2021 Guillaume Plique (Yomguithereal) | https://github.com/graphology/graphology |
| `events` | 3.3.0 | MIT | Copyright Joyent, Inc. and other Node contributors | https://github.com/browserify/events |
| `chokidar` | 5.0.0 | MIT | Copyright (c) 2012 Paul Miller (https://paulmillr.com), Elan Shanker | https://github.com/paulmillr/chokidar |
| `readdirp` | 5.1.1 | MIT | Copyright (c) 2012-2019 Thorsten Lorenz, Paul Miller (https://paulmillr.com) | https://github.com/paulmillr/readdirp |
| `ignore` | 7.0.12 | MIT | Copyright (c) 2013 Kael Zhang, contributors | https://github.com/kaelzhang/node-ignore |
| `json5` | 2.2.3 | MIT | Copyright (c) 2012-2018 Aseem Kishore, and others | https://github.com/json5/json5 |
| `ws` | 8.22.0 | MIT | Copyright (c) 2011 Einar Otto Stangvik | https://github.com/websockets/ws |

## Packaged into the desktop app

The desktop app's engine host bundles the engine packages above, and its window loads the web UI above. In addition:

| Package | Version | Licence | Copyright | Source |
| --- | --- | --- | --- | --- |
| `electron` (the app's runtime) | 44.7.2 | MIT | Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc. | https://github.com/electron/electron |
| Chromium and the other components Electron is built from | as in Electron 44.7.2 | Their own licences, listed in `LICENSES.chromium.html` | As listed in `LICENSES.chromium.html` | https://www.chromium.org |
| `electron-squirrel-startup` | 1.0.1 | Apache-2.0 | Lucas Hrabovsky (its author; its licence file names no copyright holder) | https://github.com/mongodb-js/electron-squirrel-startup |
| `debug` | 2.6.9 | MIT | Copyright (c) 2014 TJ Holowaychuk | https://github.com/debug-js/debug |
| `ms` | 2.0.0 | MIT | Copyright (c) 2016 Zeit, Inc. | https://github.com/vercel/ms |

Every desktop build carries Electron's `LICENSE` and `LICENSES.chromium.html`: next to the executable on Windows and Linux, and in `Eyrie.app/Contents/Resources` on macOS. This file ships inside the app with the web UI.

When dependencies change, regenerate the list with `pnpm licenses list --prod` and update this file in the same change.

## Licence texts

### MIT License

Applies to every package above marked MIT, with that package's copyright line.

```text
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

### ISC License

Applies to every package above marked ISC, with that package's copyright line.

```text
Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### BSD 3-Clause License

Applies to `d3-ease`.

```text
Copyright 2010-2021 Mike Bostock
Copyright 2001 Robert Penner
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the author nor the names of contributors may be used to
  endorse or promote products derived from this software without specific prior
  written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### SIL Open Font License 1.1

Applies to the Archivo and Fragment Mono fonts, with the copyright lines listed above.

```text
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### Apache License 2.0

Applies to `electron-squirrel-startup`.

```text
Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction,
and distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by
the copyright owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all
other entities that control, are controlled by, or are under common
control with that entity. For the purposes of this definition,
"control" means (i) the power, direct or indirect, to cause the
direction or management of such entity, whether by contract or
otherwise, or (ii) ownership of fifty percent (50%) or more of the
outstanding shares, or (iii) beneficial ownership of such entity.

"You" (or "Your") shall mean an individual or Legal Entity
exercising permissions granted by this License.

"Source" form shall mean the preferred form for making modifications,
including but not limited to software source code, documentation
source, and configuration files.

"Object" form shall mean any form resulting from mechanical
transformation or translation of a Source form, including but
not limited to compiled object code, generated documentation,
and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or
Object form, made available under the License, as indicated by a
copyright notice that is included in or attached to the work
(an example is provided in the Appendix below).

"Derivative Works" shall mean any work, whether in Source or Object
form, that is based on (or derived from) the Work and for which the
editorial revisions, annotations, elaborations, or other modifications
represent, as a whole, an original work of authorship. For the purposes
of this License, Derivative Works shall not include works that remain
separable from, or merely link (or bind by name) to the interfaces of,
the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including
the original version of the Work and any modifications or additions
to that Work or Derivative Works thereof, that is intentionally
submitted to Licensor for inclusion in the Work by the copyright owner
or by an individual or Legal Entity authorized to submit on behalf of
the copyright owner. For the purposes of this definition, "submitted"
means any form of electronic, verbal, or written communication sent
to the Licensor or its representatives, including but not limited to
communication on electronic mailing lists, source code control systems,
and issue tracking systems that are managed by, or on behalf of, the
Licensor for the purpose of discussing and improving the Work, but
excluding communication that is conspicuously marked or otherwise
designated in writing by the copyright owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity
on behalf of whom a Contribution has been received by Licensor and
subsequently incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of
this License, each Contributor hereby grants to You a perpetual,
worldwide, non-exclusive, no-charge, royalty-free, irrevocable
copyright license to reproduce, prepare Derivative Works of,
publicly display, publicly perform, sublicense, and distribute the
Work and such Derivative Works in Source or Object form.

3. Grant of Patent License. Subject to the terms and conditions of
this License, each Contributor hereby grants to You a perpetual,
worldwide, non-exclusive, no-charge, royalty-free, irrevocable
(except as stated in this section) patent license to make, have made,
use, offer to sell, sell, import, and otherwise transfer the Work,
where such license applies only to those patent claims licensable
by such Contributor that are necessarily infringed by their
Contribution(s) alone or by combination of their Contribution(s)
with the Work to which such Contribution(s) was submitted. If You
institute patent litigation against any entity (including a
cross-claim or counterclaim in a lawsuit) alleging that the Work
or a Contribution incorporated within the Work constitutes direct
or contributory patent infringement, then any patent licenses
granted to You under this License for that Work shall terminate
as of the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the
Work or Derivative Works thereof in any medium, with or without
modifications, and in Source or Object form, provided that You
meet the following conditions:

(a) You must give any other recipients of the Work or
Derivative Works a copy of this License; and

(b) You must cause any modified files to carry prominent notices
stating that You changed the files; and

(c) You must retain, in the Source form of any Derivative Works
that You distribute, all copyright, patent, trademark, and
attribution notices from the Source form of the Work,
excluding those notices that do not pertain to any part of
the Derivative Works; and

(d) If the Work includes a "NOTICE" text file as part of its
distribution, then any Derivative Works that You distribute must
include a readable copy of the attribution notices contained
within such NOTICE file, excluding those notices that do not
pertain to any part of the Derivative Works, in at least one
of the following places: within a NOTICE text file distributed
as part of the Derivative Works; within the Source form or
documentation, if provided along with the Derivative Works; or,
within a display generated by the Derivative Works, if and
wherever such third-party notices normally appear. The contents
of the NOTICE file are for informational purposes only and
do not modify the License. You may add Your own attribution
notices within Derivative Works that You distribute, alongside
or as an addendum to the NOTICE text from the Work, provided
that such additional attribution notices cannot be construed
as modifying the License.

You may add Your own copyright statement to Your modifications and
may provide additional or different license terms and conditions
for use, reproduction, or distribution of Your modifications, or
for any such Derivative Works as a whole, provided Your use,
reproduction, and distribution of the Work otherwise complies with
the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise,
any Contribution intentionally submitted for inclusion in the Work
by You to the Licensor shall be under the terms and conditions of
this License, without any additional terms or conditions.
Notwithstanding the above, nothing herein shall supersede or modify
the terms of any separate license agreement you may have executed
with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade
names, trademarks, service marks, or product names of the Licensor,
except as required for reasonable and customary use in describing the
origin of the Work and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or
agreed to in writing, Licensor provides the Work (and each
Contributor provides its Contributions) on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
implied, including, without limitation, any warranties or conditions
of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
PARTICULAR PURPOSE. You are solely responsible for determining the
appropriateness of using or redistributing the Work and assume any
risks associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory,
whether in tort (including negligence), contract, or otherwise,
unless required by applicable law (such as deliberate and grossly
negligent acts) or agreed to in writing, shall any Contributor be
liable to You for damages, including any direct, indirect, special,
incidental, or consequential damages of any character arising as a
result of this License or out of the use or inability to use the
Work (including but not limited to damages for loss of goodwill,
work stoppage, computer failure or malfunction, or any and all
other commercial damages or losses), even if such Contributor
has been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing
the Work or Derivative Works thereof, You may choose to offer,
and charge a fee for, acceptance of support, warranty, indemnity,
or other liability obligations and/or rights consistent with this
License. However, in accepting such obligations, You may act only
on Your own behalf and on Your sole responsibility, not on behalf
of any other Contributor, and only if You agree to indemnify,
defend, and hold each Contributor harmless for any liability
incurred by, or claims asserted against, such Contributor by reason
of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS
```

### GNU General Public License 3.0

`elkjs` is used under GPL-3.0-or-later. The full text is at https://www.gnu.org/licenses/gpl-3.0.txt. Eyrie's own [LICENSE](LICENSE) (AGPL-3.0) carries the same terms plus §13.
