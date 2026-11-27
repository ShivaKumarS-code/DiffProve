import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createE2bSandboxFactory } from './e2b-sandbox.js';

const { create, lookup } = vi.hoisted(() => ({ create: vi.fn(), lookup: vi.fn() }));

vi.mock('node:dns/promises', () => ({ lookup }));
vi.mock('e2b', async (importOriginal) => ({
  ...await importOriginal<typeof import('e2b')>(),
  Sandbox: { create },
}));

const sandbox = {
  commands: { run: vi.fn() },
  updateNetwork: vi.fn(),
  createSnapshot: vi.fn(),
  kill: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  create.mockResolvedValue(sandbox);
  sandbox.commands.run.mockResolvedValue({ exitCode: 0 });
  sandbox.kill.mockResolvedValue(true);
});

describe('E2B sandbox creation options', () => {
  it('enforces the hostname allowlist and no public ports with no general-purpose DNS in the guest', async () => {
    lookup.mockResolvedValueOnce({ address: '192.0.2.10', family: 4 });
    lookup.mockResolvedValueOnce({ address: '192.0.2.11', family: 4 });
    const factory = createE2bSandboxFactory();
    const handle = await factory.create({
      templateId: 'trusted-template',
      apiKey: 'e2b-control-plane',
      timeoutMs: 20_000,
      network: { mode: 'registries', allowOut: ['registry.npmjs.org', 'registry.yarnpkg.com'] },
    });

    expect(create).toHaveBeenCalledExactlyOnceWith('trusted-template', {
      apiKey: 'e2b-control-plane',
      timeoutMs: 20_000,
      network: {
        allowOut: ['registry.npmjs.org', 'registry.yarnpkg.com'],
        denyOut: ['0.0.0.0/0'],
        dnsServers: [],
        allowPublicTraffic: false,
      },
    });
    expect(lookup.mock.calls).toEqual([
      ['registry.npmjs.org', { family: 4 }],
      ['registry.yarnpkg.com', { family: 4 }],
    ]);
    expect(sandbox.commands.run).toHaveBeenCalledExactlyOnceWith(
      "printf '%s\\n' '192.0.2.10 registry.npmjs.org' '192.0.2.11 registry.yarnpkg.com' >> /etc/hosts && : > /etc/resolv.conf",
      { user: 'root', shell: ['/bin/sh', '-c'], timeoutMs: 15_000 },
    );
    await handle.denyNetworkEgress();
    expect(sandbox.updateNetwork).toHaveBeenCalledExactlyOnceWith({
      allowInternetAccess: false,
      denyOut: ['0.0.0.0/0'],
      dnsServers: [],
    });
  });

  it.each([undefined, 'already-locked-base-snapshot'])(
    'starts a VM from %s offline without public ports, before any command',
    async (templateId) => {
      const factory = createE2bSandboxFactory();
      await factory.create({ templateId, network: { mode: 'offline' } });

      const createOptions = {
        allowInternetAccess: false,
        network: { denyOut: ['0.0.0.0/0'], dnsServers: [], allowPublicTraffic: false },
      };
      expect(create.mock.calls).toEqual([templateId ? [templateId, createOptions] : [createOptions]]);
      expect(lookup).not.toHaveBeenCalled();
      expect(sandbox.commands.run).not.toHaveBeenCalled();
      expect(sandbox.updateNetwork).not.toHaveBeenCalled();
    },
  );

  it('closes a sandbox when its registry host setup fails', async () => {
    lookup.mockResolvedValueOnce({ address: '192.0.2.10', family: 4 });
    const error = new Error('could not update /etc/hosts');
    sandbox.commands.run.mockRejectedValueOnce(error);
    const factory = createE2bSandboxFactory();
    await expect(factory.create({
      network: { mode: 'registries', allowOut: ['registry.npmjs.org'] },
    })).rejects.toBe(error);
    expect(sandbox.kill).toHaveBeenCalledOnce();
  });

  it('captures only filesystem snapshots and never falls back to capturing memory', async () => {
    sandbox.createSnapshot
      .mockResolvedValueOnce({ snapshotId: 'filesystem-template' })
      .mockRejectedValueOnce(new Error('filesystem-only snapshots unavailable'));
    const factory = createE2bSandboxFactory();
    const handle = await factory.create({ network: { mode: 'offline' } });
    await expect(handle.createSnapshot()).resolves.toBe('filesystem-template');
    await expect(handle.createSnapshot()).resolves.toBeNull();
    expect(sandbox.createSnapshot.mock.calls).toEqual([[{ mode: 'filesystem' }], [{ mode: 'filesystem' }]]);
  });
});
