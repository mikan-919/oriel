import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliUrl = new URL("../../../dist/cli.js", import.meta.url);

async function readFirstLine(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        throw new Error(
          `The server exited before announcing readiness: ${output}`,
        );
      }

      output += decoder.decode(value, { stream: true });
      const newline = output.indexOf("\n");

      if (newline >= 0) {
        return output.slice(0, newline);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

test("serve announces one loopback health URL and serves readiness without config", async () => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "oriel-readiness-"));
  const child = Bun.spawn([process.execPath, cliUrl.pathname, "serve"], {
    cwd: workingDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [readinessStream, capturedStdout] = child.stdout.tee();
  const stdout = new Response(capturedStdout).text();
  let readinessUrl = "";

  try {
    readinessUrl = await readFirstLine(readinessStream);
    const url = new URL(readinessUrl);

    expect(url.protocol).toBe("http:");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).not.toBe("");
    expect(url.pathname).toBe("/healthz");

    const sameOriginResponse = await fetch(url, {
      headers: { Origin: url.origin },
    });

    expect(sameOriginResponse.status).toBe(200);

    const forgedHostResponse = await fetch(url, {
      headers: { Host: `forged.invalid:${url.port}` },
    });

    expect(forgedHostResponse.status).toBe(400);

    const forgedOriginResponse = await fetch(url, {
      headers: { Origin: `http://forged.invalid:${url.port}` },
    });

    expect(forgedOriginResponse.status).toBe(400);

    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.text()).toBe('{"status":"ok"}');

    // ビルド後の`dist/cli.js`から見て`dist/web`のVite buildを実際に配信できる。
    const webIndex = await fetch(new URL("/app/", url), {
      headers: { Origin: url.origin },
    });

    expect(webIndex.status).toBe(200);
    expect(webIndex.headers.get("content-type")).toContain("text/html");
    expect(await webIndex.text()).toContain('<div id="root">');
  } finally {
    child.kill();
    await child.exited;
    await rm(workingDirectory, { force: true, recursive: true });
  }

  expect(await stdout).toBe(`${readinessUrl}\n`);
});
