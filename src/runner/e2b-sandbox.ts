/**
 * E2B sandbox adapter — the ONLY module in DiffProve that imports the `e2b` SDK.
 *
 * live E2B behavior is not covered by unit tests (no account on this machine);
 * this adapter is deliberately thin and everything around it is fake-tested:
 * `src/runner/e2b-runner.ts` depends only on the `SandboxFactory` /
 * `SandboxHandle` ports from `./types.js`, and its test drives the whole
 * command choreography through a fake factory. Nothing below decides policy:
 * it maps our ports onto the SDK one call at a time.
 *
 * SDK shapes are taken from `node_modules/e2b/dist/index.d.ts` (e2b 2.64.0);
 * line numbers refer to that file:
 *  - `Sandbox.create(template?: string, opts?: SandboxOpts)` (11675-11690):
 *    the template is a POSITIONAL string, `apiKey`/`timeoutMs` live in `opts`.
 *  - `sandbox.commands.run(cmd, opts)` (6507-6510); `opts.timeoutMs` is the
 *    per-command execution timeout (6372-6376), `opts.cwd` the working dir.
 *  - `sandbox.files.write(path, data)` (6032); `UploadData` (4419) accepts both
 *    `string` and `Uint8Array`.
 *  - `sandbox.updateNetwork(network: SandboxNetworkUpdate)` (11849); an update
 *    replaces the whole egress config atomically (10018-10022).
 *  - `sandbox.createSnapshot({ name })` -> `SnapshotInfo` (11927, 10464).
 *  - `sandbox.kill(): Promise<boolean>` (11857) is the shutdown method.
 */

import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';

import { ALL_TRAFFIC, CommandExitError, Sandbox } from 'e2b';
import type { SandboxNetworkUpdate, SandboxOpts } from 'e2b';

import type { SandboxFactory, SandboxHandle, SandboxRawResult } from './types.js';

const DENY_ALL_EGRESS: SandboxNetworkUpdate = {
  allowInternetAccess: false,
  denyOut: [ALL_TRAFFIC],
  dnsServers: [],
};

async function registryHostEntries(hosts: readonly string[]): Promise<string[]> {
  return Promise.all(hosts.map(async (host) => {
    if (!/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i.test(host)) {
      throw new Error(`invalid E2B registry hostname: ${host}`);
    }
    const { address } = await lookup(host, { family: 4 });
    if (!isIPv4(address)) throw new Error(`could not resolve E2B registry hostname: ${host}`);
    return `${address} ${host}`;
  }));
}

function isTimeoutShaped(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /timeout/i.test(`${error.name} ${error.message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class E2bSandboxHandle implements SandboxHandle {
  constructor(private readonly sandbox: Sandbox) {}

  async run(
    command: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<SandboxRawResult> {
    const startedAt = Date.now();
    try {
      const result = await this.sandbox.commands.run(command, {
        cwd: opts?.cwd,
        // `timeoutMs` (CommandStartOpts, index.d.ts:6372-6376) bounds the
        // command's execution; it is NOT `requestTimeoutMs`.
        timeoutMs: opts?.timeoutMs,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOut: false,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      // `commands.run` throws `CommandExitError` for ANY non-zero exit
      // (index.d.ts:6582-6606), and that error still carries the real
      // CommandResult. Without this branch every failing command would be
      // flattened to `exitCode: null` ("error"), so a legitimately failing
      // Run A — exactly what the differential verdict needs — would be lost.
      if (error instanceof CommandExitError) {
        return {
          exitCode: error.exitCode,
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? '',
          timedOut: false,
          durationMs,
        };
      }
      return {
        exitCode: null,
        stdout: '',
        stderr: errorMessage(error),
        timedOut: isTimeoutShaped(error),
        durationMs,
      };
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.sandbox.files.write(path, content);
  }

  async denyNetworkEgress(): Promise<void> {
    // Errors intentionally propagate: the runner turns a failed lockdown into
    // an environment failure and refuses to execute untrusted code.
    await this.sandbox.updateNetwork(DENY_ALL_EGRESS);
  }

  async createSnapshot(): Promise<string | null> {
    try {
      const snapshot = await this.sandbox.createSnapshot({ mode: 'filesystem' });
      // `SnapshotInfo.snapshotId` is the reusable reference: the SDK documents it
      // as usable with `Sandbox.create()` ("template ID with tag, or namespaced
      // name with tag", index.d.ts:10464-10474). `names` is display metadata.
      return snapshot.snapshotId;
    } catch {
      // Snapshotting is an optimization; a cold run must still succeed.
      return null;
    }
  }

  async close(): Promise<void> {
    // Firecracker instances are billed until killed; `kill()` is the documented
    // shutdown method (index.d.ts:11851-11857). It resolves false when the
    // sandbox is already gone, which needs no special handling.
    await this.sandbox.kill();
  }
}

/**
 * Builds the production `SandboxFactory`. `templateId` may be a snapshot
 * reference returned by `SandboxHandle.createSnapshot` or a plain template.
 */
export function createE2bSandboxFactory(): SandboxFactory {
  return {
    async create(opts) {
      // The SDK's documented allowlist pairs allowOut with a deny for all
      // traffic. Resolve just those hosts in the worker and configure
      // /etc/hosts rather than allowing guest access to a public resolver.
      const hosts = opts.network.mode === 'registries'
        ? await registryHostEntries(opts.network.allowOut)
        : [];
      const createOpts: SandboxOpts =
        opts.network.mode === 'offline'
          ? {
              allowInternetAccess: false,
              network: { denyOut: [ALL_TRAFFIC], dnsServers: [], allowPublicTraffic: false },
            }
          : {
              network: {
                allowOut: [...opts.network.allowOut],
                denyOut: [ALL_TRAFFIC],
                dnsServers: [],
                allowPublicTraffic: false,
              },
            };
      if (opts.apiKey !== undefined) {
        createOpts.apiKey = opts.apiKey;
      }
      if (opts.timeoutMs !== undefined) {
        createOpts.timeoutMs = opts.timeoutMs;
      }
      // Template is positional in this SDK; omitting it keeps the SDK default
      // (`base`). Never pass a second/`{ template }` argument: that overload
      // does not exist here.
      const sandbox =
        opts.templateId === undefined
          ? await Sandbox.create(createOpts)
          : await Sandbox.create(opts.templateId, createOpts);
      if (hosts.length > 0) {
        try {
          // Entries contain only validated IPv4 addresses and domain names.
          // Clear the unreachable resolver to avoid waiting for DNS timeouts.
          await sandbox.commands.run(`printf '%s\\n' ${hosts.map((host) => `'${host}'`).join(' ')} >> /etc/hosts && : > /etc/resolv.conf`, {
            user: 'root',
            shell: ['/bin/sh', '-c'],
            timeoutMs: 15_000,
          });
        } catch (error) {
          await sandbox.kill().catch(() => undefined);
          throw error;
        }
      }
      return new E2bSandboxHandle(sandbox);
    },
  };
}
