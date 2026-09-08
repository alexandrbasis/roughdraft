import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentSetupPrompt,
  releaseArchive,
} from "../packages/server/release-info.mjs";

test("setup instructions follow the manifest for a future release", () => {
  const manifest = {
    name: "@alexandrbasis/roughdraft",
    version: "0.3.2-basis.4",
    repository: { url: "git+https://github.com/alexandrbasis/roughdraft.git" },
  };
  assert.equal(
    releaseArchive(manifest).url,
    "https://github.com/alexandrbasis/roughdraft/releases/download/v0.3.2-basis.4/alexandrbasis-roughdraft-0.3.2-basis.4.tgz",
  );
  assert.equal(
    agentSetupPrompt(manifest),
    "Install the Basis fork of Roughdraft using `npm install -g https://github.com/alexandrbasis/roughdraft/releases/download/v0.3.2-basis.4/alexandrbasis-roughdraft-0.3.2-basis.4.tgz`, then read `roughdraft help agent` and set yourself up to use it.",
  );
});

test("release instructions reject invalid version and repository inputs", () => {
  const manifest = {
    name: "@alexandrbasis/roughdraft",
    version: "0.3.2",
    repository: "https://github.com/alexandrbasis/roughdraft",
  };
  for (const version of [
    "latest",
    "v0.3.2",
    "0.3.2; echo unsafe",
    "../../bad",
  ]) {
    assert.equal(releaseArchive(manifest, version), null);
  }
  assert.equal(
    releaseArchive({ ...manifest, repository: "https://example.com/fake" }),
    null,
  );
  assert.equal(releaseArchive({ ...manifest, name: "roughdraft" }), null);
});
