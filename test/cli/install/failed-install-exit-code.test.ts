import { spawn } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "fs/promises";
import { bunEnv, bunExe } from "harness";
import { join } from "path";
import {
  createTestContext,
  destroyTestContext,
  dummyAfterAll,
  dummyBeforeAll,
  dummyRegistryForContext,
  setContextHandler,
  type TestContext,
} from "./dummy.registry";

beforeAll(dummyBeforeAll);
afterAll(dummyAfterAll);

async function run(ctx: TestContext, cmd: string, stdin?: string) {
  await using proc = spawn({
    cmd: [bunExe(), ...cmd.split(" ")],
    cwd: ctx.package_dir,
    env: { ...bunEnv, BUN_INSTALL_GLOBAL_DIR: join(ctx.package_dir, "global") },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    proc.stdin!.write(stdin);
    proc.stdin!.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

// An installed project with a `file:` dependency `dep`, a package `linked` that is registered
// for `bun link`, and a registry that serves `baz` 0.0.3 and 0.0.5.
async function withProject(dependencies: Record<string, string>, fn: (ctx: TestContext) => Promise<void>) {
  const ctx = await createTestContext({ linker: "hoisted" });
  try {
    setContextHandler(ctx, dummyRegistryForContext(ctx, [], { "0.0.3": {}, "0.0.5": {} }));
    const dir = ctx.package_dir;
    for (const name of ["dep", "linked"]) {
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    }
    await mkdir(join(dir, "global", "node_modules"), { recursive: true });
    await symlink(join(dir, "linked"), join(dir, "global", "node_modules", "linked"), "junction");
    await writeFile(join(dir, "entry.js"), `import "baz";`);
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { dep: "file:./dep", ...dependencies } }),
    );
    expect(await run(ctx, "install")).toMatchObject({ exitCode: 0 });
    await fn(ctx);
  } finally {
    destroyTestContext(ctx);
  }
}

// The lockfile resolves `dep` to a folder that no longer exists, so the install step of every
// command fails to place that one package.
async function withFailingInstall(dependencies: Record<string, string>, fn: (ctx: TestContext) => Promise<void>) {
  await withProject(dependencies, async ctx => {
    await rm(join(ctx.package_dir, "dep"), { recursive: true });
    await rm(join(ctx.package_dir, "node_modules"), { recursive: true });
    await fn(ctx);
  });
}

describe("when a package fails to install", () => {
  test.each([
    { cmd: "install" },
    { cmd: "add baz" },
    { cmd: "link linked" },
    { cmd: "install baz" },
    { cmd: "install --analyze entry.js" },
    { cmd: "remove not-a-dependency" },
    // Space selects baz, Enter confirms.
    { cmd: "update --interactive --latest", dependencies: { baz: "0.0.3" }, stdin: " \r" },
  ])("bun $cmd exits 1", async ({ cmd, dependencies = {}, stdin }) => {
    await withFailingInstall(dependencies, async ctx => {
      const { stdout, exitCode } = await run(ctx, cmd, stdin);
      expect({ stdout, exitCode }).toEqual({
        stdout: expect.stringContaining("Failed to install 1 package"),
        exitCode: 1,
      });
    });
  });

  test("bun link <pkg> --silent exits 1", async () => {
    await withFailingInstall({}, async ctx => {
      const { stdout, exitCode } = await run(ctx, "link linked --silent");
      expect({ stdout, exitCode }).toEqual({ stdout: "", exitCode: 1 });
    });
  });

  test("bun patch <pkg> prepares the patch before it exits 1", async () => {
    await withFailingInstall({ baz: "0.0.3" }, async ctx => {
      const { stdout, exitCode } = await run(ctx, "patch baz");
      expect({ stdout, exitCode }).toEqual({
        stdout: expect.stringMatching(/Failed to install 1 package.*To patch baz/s),
        exitCode: 1,
      });
    });
  });
});

test("bun remove <name that is not a dependency> exits 0 when every package installs", async () => {
  await withProject({}, async ctx => {
    const { stdout, exitCode } = await run(ctx, "remove not-a-dependency");
    expect({ stdout, exitCode }).toEqual({
      stdout: expect.not.stringContaining("Failed to install"),
      exitCode: 0,
    });
  });
});
