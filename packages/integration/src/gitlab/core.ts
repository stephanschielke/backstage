/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  getGitLabIntegrationRelativePath,
  GitLabIntegrationConfig,
} from './config';
import fetch from 'cross-fetch';
import { InputError } from '@backstage/errors';

/**
 * Given a URL pointing to a file on a provider, returns a URL that is suitable
 * for fetching the contents of the data.
 *
 * @remarks
 *
 * Converts
 * from: https://gitlab.example.com/a/b/blob/master/c.yaml
 * to:   https://gitlab.example.com/a/b/raw/master/c.yaml
 * -or-
 * from: https://gitlab.com/groupA/teams/teamA/subgroupA/repoA/-/blob/branch/filepath
 * to:   https://gitlab.com/api/v4/projects/projectId/repository/files/filepath?ref=branch
 *
 * @param url - A URL pointing to a file
 * @param config - The relevant provider config
 * @public
 */
export async function getGitLabFileFetchUrl(
  url: string,
  config: GitLabIntegrationConfig,
): Promise<string> {
  // TODO(Rugvip): From the old GitlabReaderProcessor; used
  // the existence of /-/blob/ to switch the logic. Don't know if this
  // makes sense and it might require some more work.

  if (url.includes('/-/blob/')) {
    const projectID = await getProjectId(url, config);
    return buildProjectUrl(url, projectID, config).toString();
  }
  return buildRawUrl(url).toString();
}

/**
 * Gets the request options necessary to make requests to a given provider.
 *
 * @param config - The relevant provider config
 * @public
 */
export function getGitLabRequestOptions(config: GitLabIntegrationConfig): {
  headers: Record<string, string>;
} {
  const { token = '' } = config;
  return {
    headers: {
      'PRIVATE-TOKEN': token,
    },
  };
}

// Converts
// from: https://gitlab.example.com/groupA/teams/repoA/blob/master/c.yaml
// to:   https://gitlab.example.com/groupA/teams/repoA/raw/master/c.yaml
export function buildRawUrl(target: string): URL {
  try {
    const url = new URL(target);

    const splitPath = url.pathname.split('/').filter(Boolean);

    // Check blob existence
    const blobIndex = splitPath.indexOf('blob', 2);
    if (blobIndex < 2 || blobIndex === splitPath.length - 1) {
      throw new InputError('Wrong GitLab URL');
    }

    // Take repo path
    const repoPath = splitPath.slice(0, blobIndex);
    const restOfPath = splitPath.slice(blobIndex + 1);

    if (!restOfPath.join('/').match(/\.(yaml|yml)$/)) {
      throw new InputError('Wrong GitLab URL');
    }

    // Replace 'blob' with 'raw'
    url.pathname = [...repoPath, 'raw', ...restOfPath].join('/');

    return url;
  } catch (e) {
    throw new InputError(`Incorrect url: ${target}, ${e}`);
  }
}

// Converts
// from: https://gitlab.com/groupA/teams/teamA/subgroupA/repoA/-/blob/branch/filepath
// to:   https://gitlab.com/api/v4/projects/projectId/repository/files/filepath?ref=branch
export function buildProjectUrl(
  target: string,
  projectID: Number,
  config: GitLabIntegrationConfig,
): URL {
  try {
    const url = new URL(target);

    const branchAndFilePath = url.pathname.split('/-/blob/')[1];
    const [branch, ...filePath] = branchAndFilePath.split('/');
    const relativePath = getGitLabIntegrationRelativePath(config);

    url.pathname = [
      ...(relativePath ? [relativePath] : []),
      'api/v4/projects',
      projectID,
      'repository/files',
      encodeURIComponent(decodeURIComponent(filePath.join('/'))),
      'raw',
    ].join('/');

    url.search = `?ref=${branch}`;

    return url;
  } catch (e) {
    throw new Error(`Incorrect url: ${target}, ${e}`);
  }
}

// Convert
// from: https://gitlab.com/groupA/teams/teamA/subgroupA/repoA/-/blob/branch/filepath
// to:   The project ID that corresponds to the URL
export async function getProjectId(
  target: string,
  config: GitLabIntegrationConfig,
): Promise<number> {
  const url = new URL(target);

  if (!url.pathname.includes('/-/blob/')) {
    throw new Error('Please provide full path to yaml file from GitLab');
  }

  try {
    let repo = url.pathname.split('/-/blob/')[0];

    // Get gitlab relative path
    const relativePath = getGitLabIntegrationRelativePath(config);

    // Check relative path exist and replace it if it's the case.
    if (relativePath) {
      repo = repo.replace(relativePath, '');
    }

    // Convert
    // to: https://gitlab.com/api/v4/projects/groupA%2Fteams%2FsubgroupA%2FteamA%2Frepo
    const repoIDLookup = new URL(
      `${url.origin}${relativePath}/api/v4/projects/${encodeURIComponent(
        repo.replace(/^\//, ''),
      )}`,
    );

    const response = await fetch(
      repoIDLookup.toString(),
      getGitLabRequestOptions(config),
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        `GitLab Error '${data.error}', ${data.error_description}`,
      );
    }

    return Number(data.id);
  } catch (e) {
    throw new Error(`Could not get GitLab project ID for: ${target}, ${e}`);
  }
}
