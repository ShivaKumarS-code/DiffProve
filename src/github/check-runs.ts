/** Completes the worker's exact check as neutral for no-test and other skips. */
import type { Octokit } from '@octokit/core';

import type { CheckRunReporter } from '../diff/types.js';
import { completeCheckRun, withCheckRequest } from './checks.js';
import type { InstallationTokenSource } from './octokit.js';

export function createCheckRunReporter(
  octokit: Octokit,
  authenticator: InstallationTokenSource,
): CheckRunReporter {
  return {
    async reportNoTestChanges(report) {
      const { checkRunId, title, summary } = report;
      if (checkRunId === undefined) {
        throw new Error('cannot report a neutral check without the worker check run ID');
      }
      await withCheckRequest(report, authenticator, 'complete DiffProve check run as neutral', (scope) =>
        completeCheckRun(octokit, scope, checkRunId, {
          conclusion: 'neutral',
          output: { title, summary },
        }),
      );
    },
  };
}
