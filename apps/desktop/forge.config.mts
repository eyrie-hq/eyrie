import { copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// A pre-release (0.1.0-rc.2) must sort before its release (0.1.0) for apt and dnf to upgrade from it.
// The .deb maker writes 0.1.0~rc.2 itself; the .rpm maker would write 0.1.0.rc.2, which sorts after.
const version: string = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

// The Linux packages are named eyrie-desktop, and so is the command they install
// (/usr/bin/eyrie-desktop), so that plain `eyrie` stays free for the command-line tool.
const linux = {
  name: 'eyrie-desktop',
  // The executable the command points at. Left out, the makers look for one named after package.json (@eyrie/desktop).
  bin: 'eyrie',
  productName: 'Eyrie',
  genericName: 'Architecture map',
  homepage: 'https://github.com/eyrie-hq/eyrie',
  categories: ['Development' as const],
  icon: 'assets/icon.png',
};

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Eyrie',
    executableName: 'eyrie',
    appBundleId: 'io.github.badhansen.eyrie',
    appCategoryType: 'public.app-category.developer-tools',
    asar: true,
    // assets/icon.icns on macOS, assets/icon.ico on Windows; `pnpm icons` renders them from assets/icon.svg.
    icon: 'assets/icon',
    // Read from disk at run time, so they ship next to the app rather than inside the bundle.
    // `pnpm resources` (scripts/prepare-resources.ts) fills these folders, and copies the
    // icon the window shows on Linux. resources/cli is the single-executable `eyrie`
    // command with its grammars and web UI, for coding agents.
    extraResource: ['resources/web', 'resources/grammars', 'resources/icon.png', 'resources/cli'],
    // Not notarized, so signed ad hoc: without it the bundle keeps Electron's own signature,
    // which packaging breaks, and macOS calls a downloaded copy damaged. With it, the first
    // launch is the usual System Settings → Privacy & Security → Open Anyway. Hardened
    // runtime and timestamps only matter for notarization.
    osxSign: {
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerDMG({ icon: 'assets/icon.icns' }),
    // The ZIP is what macOS auto-update would read, should Eyrie get it.
    new MakerZIP({}, ['darwin']),
    // `name` defaults to package.json's, and a scoped name (@eyrie/desktop) is not a valid NuGet id.
    // Squirrel shows iconUrl in Installed apps, and fetches it there and then.
    new MakerSquirrel({ name: 'eyrie', setupIcon: 'assets/icon.ico', iconUrl: 'https://raw.githubusercontent.com/eyrie-hq/eyrie/main/apps/desktop/assets/icon.ico' }),
    new MakerDeb({ options: { ...linux, section: 'devel', maintainer: 'Badhan Sen <37157382+Badhansen@users.noreply.github.com>' } }),
    new MakerRpm({ options: { ...linux, license: 'AGPL-3.0-only', version: version.replace('-', '~') } }),
  ],
  hooks: {
    // Windows and Linux builds keep Electron's LICENSE and Chromium's LICENSES.chromium.html next to
    // the executable. On macOS they sit outside Eyrie.app, which is all the DMG and ZIP carry, so
    // they are copied into its Resources before it is signed.
    packageAfterExtract: async (_config, buildPath, _electronVersion, platform) => {
      if (platform !== 'darwin') return;
      const bundle = readdirSync(buildPath).find((name) => name.endsWith('.app'));
      if (!bundle) throw new Error(`No .app in ${buildPath}`);
      for (const file of ['LICENSE', 'LICENSES.chromium.html']) copyFileSync(join(buildPath, file), join(buildPath, bundle, 'Contents', 'Resources', file));
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.mts', target: 'main' },
        // The engine and its server, run as a utility process (see src/engine-host.ts).
        { entry: 'src/engine-host.ts', config: 'vite.host.config.mts', target: 'main' },
        // The window's sandboxed preload (src/preload.ts) → .vite/build/preload.cjs.
        { entry: 'src/preload.ts', config: 'vite.main.config.mts', target: 'preload' },
      ],
      // No renderer of its own: the Projects page is built with the web UI (apps/web/projects.html)
      // and served from resources/web, and a project's map is the UI its engine serves on 127.0.0.1.
      renderer: [],
    }),
    // Flipped at package time, before code signing.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
