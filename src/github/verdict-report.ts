/** Completes the worker's exact check with the rendered Run A / Run B verdict. */
import type { Octokit } from '@octokit/core';

import type { VerdictReporter } from '../runner/types.js';
import { completeCheckRun, withCheckRequest } from './checks.js';
import type { InstallationTokenSource } from './octokit.js';

export function createVerdictReporter(
  octokit: Octokit,
  authenticator: InstallationTokenSource,
): VerdictReporter {
  return {
    async reportVerdict(report) {
      const { checkRunId, title, summary } = report;
      if (checkRunId === undefined) {
        throw new Error('cannot report a verdict without the worker check run ID');
      }
      await withCheckRequest(report, authenticator, `report ${report.verdict} verdict`, (scope) =>
        completeCheckRun(octokit, scope, checkRunId, {
          conclusion: report.conclusion,
          output: { title, summary },
        }),
      );
    },
  };
}
