import got, { Headers, HTTPError } from 'got';
import wwwAuthenticate from 'www-authenticate';
import chalk from 'chalk';
import log from './logger';
import { exec } from '../util';
import is from '@sindresorhus/is';

const registry = 'https://index.docker.io';

type DockerManifestV2 = {
  schemaVersion: number;
  config: {
    digest: string;
  };
};

export async function getAuthHeaders(
  registry: string,
  repository: string
): Promise<Headers> {
  try {
    const apiCheckUrl = `${registry}/v2/`;
    const apiCheckResponse = await got(apiCheckUrl, { throwHttpErrors: false });
    if (apiCheckResponse.headers['www-authenticate'] === undefined) {
      return {};
    }
    const authenticateHeader = new wwwAuthenticate.parsers.WWW_Authenticate(
      apiCheckResponse.headers['www-authenticate']
    );

    const authUrl = `${authenticateHeader.parms.realm}?service=${authenticateHeader.parms.service}&scope=repository:${repository}:pull`;
    const authResponse = (
      await got<{ token?: string; access_token?: string }>(authUrl, {
        responseType: 'json',
      })
    ).body;

    const token = authResponse.token || authResponse.access_token;
    if (!token) {
      throw new Error('Failed to obtain docker registry token');
    }
    return {
      authorization: `Bearer ${token}`,
    };
  } catch (err) {
    log.error(chalk.red('auth error'), err.message);
    throw new Error('Failed to obtain docker registry token');
  }
}

export enum DockerContentType {
  ManifestV1 = 'application/vnd.docker.distribution.manifest.v1+json',
  ManifestV2 = 'application/vnd.docker.distribution.manifest.v2+json',
}

const shaRe = /(sha256:[a-f0-9]{64})/;

export async function getRemoteImageId(
  repository: string,
  tag = 'latest'
): Promise<string> {
  const headers = await getAuthHeaders(registry, repository);
  headers.accept = DockerContentType.ManifestV2;
  const url = `${registry}/v2/${repository}/manifests/${tag}`;

  try {
    const resp = await got<DockerManifestV2>(url, {
      headers,
      responseType: 'json',
    });
    if (resp.headers['content-type'] !== DockerContentType.ManifestV2) {
      throw new Error(`Unsupported response: ${resp.headers['content-type']}`);
    }
    return resp.body.config.digest;
  } catch (e) {
    if (e instanceof HTTPError && e.response.statusCode === 404) {
      // no image published yet
      return '<none>';
    }
    log.error(chalk.red('request error'), e.message);
    throw new Error('Could not find remote image id');
  }
}

export async function getLocalImageId(
  image: string,
  tag = 'latest'
): Promise<string> {
  const res = await exec('docker', [
    'inspect',
    "--format='{{.Id}}'",
    `${image}:${tag}`,
  ]);

  const [, id] = shaRe.exec(res.stdout) ?? [];

  if (!id) {
    log.error(res);
    throw new Error('Could not find local image id');
  }

  return id;
}

export type BuildOptions = {
  image: string;
  cache?: string;
  cacheTags?: string[];
  tag?: string;
  dryRun?: boolean;
  buildArg?: string;
  buildArgs?: string[];
};

export async function build({
  image,
  cache,
  cacheTags,
  tag = 'latest',
  dryRun,
  buildArg,
  buildArgs,
}: BuildOptions): Promise<void> {
  const args = ['buildx', 'build', '--load', `--tag=renovate/${image}:${tag}`];

  if (is.nonEmptyString(buildArg)) {
    args.push(`--build-arg=${buildArg}=${tag}`);
  }

  if (is.nonEmptyArray(buildArgs)) {
    args.push(...buildArgs.map((b) => `--build-arg=${b}`));
  }

  if (is.string(cache)) {
    const cacheImage = `renovate/${cache}:${image.replace(/\//g, '-')}`;
    args.push(`--cache-from=${cacheImage}-${tag}`);

    if (is.nonEmptyArray(cacheTags)) {
      for (const ctag of cacheTags) {
        args.push(`--cache-from=${cacheImage}-${ctag}`);
      }
    }

    if (!dryRun) {
      args.push(`--cache-to=type=registry,ref=${cacheImage}-${tag},mode=max`);
    }
  }

  await exec('docker', [...args, '.']);
}

type PublishOptions = {
  image: string;
  tag: string;
  dryRun?: boolean;
};

export async function publish({
  image,
  tag,
  dryRun,
}: PublishOptions): Promise<void> {
  const imageName = `renovate/${image}`;
  const fullName = `${imageName}:${tag}`;
  log.info(chalk.blue('Processing image:'), chalk.yellow(fullName));

  log('Fetch new id');
  const newId = await getLocalImageId(imageName, tag);

  log('Fetch old id');
  const oldId = await getRemoteImageId(imageName, tag);

  if (oldId === newId) {
    log('Image uptodate, no push nessessary:', chalk.yellow(oldId));
    return;
  }

  log('Publish new image', `${oldId} => ${newId}`);
  if (dryRun) {
    log.warn(chalk.yellow('[DRY_RUN]'), chalk.blue('Would push:'), fullName);
  } else {
    await exec('docker', ['push', fullName]);
  }
  log.info(chalk.blue('Processing image finished:', newId));
}
