# AGENTS.md

Release checklist for this Cortico World extension. Contract references:
[docs/worlds.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/worlds.md) and
[docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md).

- [ ] **Contract version**: `cortico.api` is `6` for a World. Any other value does not load.
- [ ] **Self-description**: after changing tools, event types or the env prompt, keep
      `describe.json` in sync by hand (this package is not inside a Cortico checkout, so
      `pnpm describe:extension` cannot be run here). `tests/world.test.ts` compares
      `tools()`, `describe.json` and `ENV_PROMPT.md`, so a drift fails the suite.
- [ ] **Config paths**: every path in `src/config.ts` starts with `worlds.arknights.` and has a
      matching entry in `defaults()`.
- [ ] **Tool names**: keep the `ark_` prefix; names are unique across the whole bot.
- [ ] **Tags**: `cortico.tags` lists every tag from
      [TAGS.md](https://github.com/Pal-AI-Lab/cortico-extensions/blob/main/TAGS.md) whose "when"
      fits, notice and warning tags included.
- [ ] **CHANGELOG.md** has a `## <version>` section for the version being published.
- [ ] **`os`**: stays `["win32"]`; the native dependency has no other usable controller for this use case.
- [ ] **`files`**: ships `src`, `assets`, `README.md`, `BATTLE_PLAYBOOK.md`, `CHANGELOG.md`, `LICENSE`, `describe.json` only.
      `tests/` stays out of the published package, and real-machine scripts live in the repo-level
      `test/` package, never here.
- [ ] **Resources**: `assets` ships only our own `resource/pipeline` and the bundled OCR model.
      Never copy MAA's `tasks/`, `template/`, `copilot/`, `roguelike/` or `Arknights-Tile-Pos/` into the
      package; coordinates and ROIs borrowed from MAA are rewritten as our own constants.
- [ ] **OCR assets**: `assets/resource/model/ocr/` must keep `det.onnx`, `rec.onnx` and `keys.txt`
      flat in that one directory. MaaFramework looks up exactly these three names and never descends
      into subdirectories; a nested copy fails at recognition time with `det=0 rec=0`.
- [ ] **`pnpm test` and `pnpm typecheck`** pass, and the smoke script in `test/` has been run once
      against a real game window before publishing.
- [ ] **No network, no secrets**: the extension must not add outbound requests or read `ctx.secret()`.

Requests to the maintainers (tag changes, certification, a replacement package, appeals) are issues in
[Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions), in the plain-text
format that `check:extension` prints and the index repository README describes.
