import { expect, test } from "bun:test";
import { githubRepoFromRemote, repoFromRemote, repoFromRemoteUrl } from "../src/git-remote.ts";

test("repoFromRemote parses supported remote forms and preserves case", () => {
  expect(repoFromRemote("https://github.com/Dubusoft/dori-mode.git")).toBe("Dubusoft/dori-mode");
  expect(repoFromRemote("git@github.com:o/r.git")).toBe("o/r");
  expect(repoFromRemote("ssh://git@host.example/o/r.git")).toBe("o/r");
  expect(repoFromRemote("https://x-token@github.com/o/my.repo.git/")).toBe("o/my.repo");
  expect(repoFromRemote("app")).toBeUndefined();
});

test("repoFromRemoteUrl rejects local paths", () => {
  expect(repoFromRemoteUrl("https://host/o/r.git")).toBe("o/r");
  expect(repoFromRemoteUrl("/local/path/repo")).toBeUndefined();
});

test("githubRepoFromRemote limits hosts to GitHub and lowercases owner/repo", () => {
  expect(githubRepoFromRemote("https://github.com/Dubusoft/dori-mode.git")).toBe("dubusoft/dori-mode");
  expect(githubRepoFromRemote("git@github.com:Acme/App.git")).toBe("acme/app");
  expect(githubRepoFromRemote("ssh://git@github.com/Acme/App.git")).toBe("acme/app");
  expect(githubRepoFromRemote("ssh://git@host.example/Acme/App.git")).toBeUndefined();
  expect(githubRepoFromRemote("https://github.com/only-owner")).toBeUndefined();
});
